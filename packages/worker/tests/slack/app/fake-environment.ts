import * as v from "valibot";
import type { SlackPlatformGateway } from "../../../src/components/slack/entity/slack-platform-gateway.ts";
import type { SlackMessage } from "../../../src/components/slack/service/bot-tools/slack-bot-tool-service";
import type { AttachmentStorageResolver } from "../../../src/components/slack/storage/attachment-storage-resolver.ts";
import type { SlackAttachmentStorage } from "../../../src/components/slack/storage/slack-attachment-storage.ts";
import { IdentityGateway } from "../../../src/gateway/identity-gateway";
import { SlackWebApi } from "../../../src/gateway/slack-web-gateway";

class FakeAttachmentBucket implements SlackAttachmentStorage {
    readonly #objects = new Map<string, { readonly body: ArrayBuffer; readonly contentType: string }>();
    readonly get = async (key: string, signal: AbortSignal): Promise<Response | null> => {
        signal.throwIfAborted();
        const object = this.#objects.get(key);
        return object === undefined
            ? null
            : new Response(object.body.slice(0), { headers: { "Content-Type": object.contentType } });
    };
    readonly put = async (key: string, response: Response, contentType: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const body = await response.arrayBuffer();
        signal.throwIfAborted();
        this.#objects.set(key, { body, contentType });
    };
}

export class FakeAttachments implements AttachmentStorageResolver {
    readonly bucket = new FakeAttachmentBucket();
    readonly resolve: AttachmentStorageResolver["resolve"] = () => this.bucket;
}

export class FakeIdentityGateway extends IdentityGateway {
    readonly bots = new Set(["tenant-1:bot-1", "tenant-1:bot-source"]);
    constructor() {
        super({ config: { serviceToken: "test-service-token" } });
    }
    override readonly request = async (url: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        if (url.endsWith("/credentials/verify")) {
            const credential = v.parse(v.object({ authorization: v.string() }), body).authorization;
            if (credential !== "test-bot") {
                throw new Error("Invalid bot credential");
            }
            return { kind: "agent", tenantId: "tenant-1", agentId: "bot-1" };
        }
        const input = v.parse(
            v.object({
                tenantId: v.string(),
                agentId: v.optional(v.string()),
                targetAgentId: v.optional(v.string()),
            }),
            body,
        );
        return {
            allowed: this.bots.has(`${input.tenantId}:${input.agentId ?? input.targetAgentId}`),
        };
    };
}

// Stateful fake for the generic Project Session boundary used by Slack.
export class FakeMobius implements SlackPlatformGateway {
    readonly runs: {
        readonly botId: string;
        readonly clientMessageId: string;
        readonly conversationId: string;
        readonly instructions: string;
        readonly prompt: string;
    }[] = [];
    readonly results = new Map<string, string>();
    readonly #sessions = new Map<string, string>();
    responseText = "Investigation complete";
    connectionState: "connected" | "disconnect-after-result" = "connected";
    #gate: { readonly started: () => void; readonly completed: Promise<void> } | null = null;

    readonly pauseNext = () => {
        let started: () => void = () => undefined;
        let complete: () => void = () => undefined;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
        });
        const completed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        this.#gate = { started, completed };
        return { started: startedPromise, complete };
    };

    readonly createPairing = async (_projectId: string, _idempotencyKey: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { pairingId: "pairing-1", pairingCode: "PAIR-ONE", status: "pending" };
    };

    readonly readPairing = async (_projectId: string, _pairingId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { status: "pending" };
    };

    readonly openAutomatedChatSession = async (
        _projectId: string,
        selection: { readonly bindingId: string },
        sessionId: string,
        _title: string,
        signal: AbortSignal,
    ): Promise<string> => {
        signal.throwIfAborted();
        const existing = this.#sessions.get(sessionId);
        if (existing !== undefined && existing !== selection.bindingId) {
            throw new Error("Session binding changed");
        }
        this.#sessions.set(sessionId, selection.bindingId);
        return sessionId;
    };

    readonly submitAutomatedChatTurn = async (
        _projectId: string,
        sessionId: string,
        input: { readonly commandId: string; readonly prompt: string; readonly instructions: string },
        signal: AbortSignal,
    ): Promise<{ readonly text: string; readonly stopReason: string }> => {
        signal.throwIfAborted();
        if (!this.results.has(input.commandId)) {
            this.runs.push({
                botId: "chat-bot-1",
                clientMessageId: input.commandId,
                conversationId: sessionId,
                instructions: input.instructions,
                prompt: input.prompt,
            });
            const gate = this.#gate;
            this.#gate = null;
            if (gate !== null) {
                gate.started();
                await waitForGate(gate.completed, signal);
            }
            this.results.set(input.commandId, this.responseText);
            if (this.connectionState === "disconnect-after-result") {
                this.connectionState = "connected";
                throw new TypeError("Connection closed");
            }
        }
        return { text: this.results.get(input.commandId) ?? "", stopReason: "end_turn" };
    };
}

export class FakeSlack extends SlackWebApi {
    readonly files = new Map<string, string>();
    override readonly downloadFile = async (_token: string, url: string, signal: AbortSignal): Promise<Response> => {
        signal.throwIfAborted();
        const body = this.files.get(url);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    };
    readonly messages: Array<{
        readonly token: string;
        readonly channelId: string;
        readonly text: string;
        readonly threadTs: string | null;
    }> = [];
    readonly statuses = new Map<string, string>();
    readonly ephemeral: string[] = [];
    readonly oauthCodes = new Map<string, string>([["oauth-code", "client-1"]]);
    channelMessages: readonly SlackMessage[] = [];
    threadMessages: readonly SlackMessage[] = [];
    override readonly postMessage = async (
        token: string,
        channelId: string,
        text: string,
        threadTs: string | null,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        this.messages.push({ token, channelId, text, threadTs });
        return { channelId, ts: `${this.messages.length}.0` };
    };
    override readonly sendMessage = this.postMessage;
    override readonly sendDirectMessage = async (token: string, userId: string, text: string, signal: AbortSignal) =>
        await this.postMessage(token, `D:${userId}`, text, null, signal);
    override readonly getChannelHistory = async (
        _input: Parameters<SlackWebApi["getChannelHistory"]>[0],
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.channelMessages;
    };
    override readonly getThreadHistory = async (
        _input: Parameters<SlackWebApi["getThreadHistory"]>[0],
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.threadMessages;
    };
    override readonly getThreadMessages = async (
        _token: string,
        _channel: string,
        _thread: string,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.threadMessages;
    };
    override readonly getUserName = async (_token: string, user: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return user;
    };
    override readonly getBotAppId = async (_token: string, bot: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return bot === "B_SOURCE" ? "A_SOURCE" : null;
    };
    override readonly setThreadStatus = async (
        _token: string,
        channel: string,
        thread: string,
        status: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.statuses.set(`${channel}:${thread}`, status);
    };
    override readonly postEphemeral = async (
        _token: string,
        _channel: string,
        _user: string,
        text: string,
        _thread: string | null,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.ephemeral.push(text);
    };
    override readonly exchangeCode = async (input: Parameters<SlackWebApi["exchangeCode"]>[0], signal: AbortSignal) => {
        signal.throwIfAborted();
        if (this.oauthCodes.get(input.code) !== input.clientId || input.clientSecret !== "client-secret") {
            throw new Error("Invalid OAuth credentials");
        }
        this.oauthCodes.delete(input.code);
        return {
            accessToken: "xoxb-token",
            authedUserId: "U_INSTALLER",
            botUserId: "U_BOT",
            teamId: "T123",
            teamName: "Example",
        };
    };
}

async function waitForGate(completed: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        void completed.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
        }, reject);
    });
    signal.throwIfAborted();
}
