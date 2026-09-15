import { decodeNativeSessionResult, decodeSessionReadyEvent } from "@moxt-ai/mobius-protocol";
import { createMobiusConversationSession, MobiusBrowserAccessToken, MobiusClient } from "@moxt-ai/mobius-sdk/browser";
import * as v from "valibot";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const accessSchema = v.pipe(
    v.strictObject({
        endpoint: v.pipe(v.string(), v.url()),
        conversationId: identifier,
        credential: v.pipe(v.string(), v.regex(/^mconv_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/u)),
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const agentSelectionSchema = v.object({
    runtimeId: identifier,
    agentRef: identifier,
    workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    agentConfigRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const workspaceSchema = v.object({
    status: v.string(),
    selected: v.nullable(agentSelectionSchema),
    agents: v.array(
        v.object({
            runtimeId: identifier,
            agentRef: identifier,
            label: v.string(),
            machineName: v.string(),
            online: v.boolean(),
        }),
    ),
});
export type ChatWorkspace = v.InferOutput<typeof workspaceSchema>;
export type ChatAgentSelection = v.InferOutput<typeof agentSelectionSchema>;
export interface ChatDraftConfiguration {
    readonly bindingId: string;
    readonly configuration: {
        readonly additionalDirectoryIds: readonly string[];
        readonly booleanValue: boolean;
        readonly configId: string;
        readonly value: string;
        readonly valueType: "select" | "boolean";
    };
}
const sessionAccessSchema = v.object({
    sessionId: identifier,
    projectId: identifier,
    credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u)),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    endpoint: v.pipe(v.string(), v.url()),
});
function sessionEndpoint(value: string): string {
    const endpoint = new URL(value);
    if (
        endpoint.username !== "" ||
        endpoint.password !== "" ||
        endpoint.pathname !== "/" ||
        endpoint.search !== "" ||
        endpoint.hash !== "" ||
        (endpoint.protocol !== "https:" &&
            !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))
    ) {
        throw new CloudApiError("INVALID_SESSION_ENDPOINT", "The Session endpoint is invalid.");
    }
    return endpoint.origin;
}

export class BotChatApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #projectId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly listBots: ManagementApi["listBots"];
    constructor(options: {
        readonly fetchRequest?: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#projectId = v.parse(identifier, options.projectId);
        this.#fetchRequest = options.fetchRequest ?? ((request) => fetch(request));
        this.#getToken = options.getToken;
        this.listBots = new ManagementApi(options).listBots;
    }
    readonly access = async (botId: string, parent: AbortSignal, conversationId: string): Promise<ChatAccess> =>
        v.parse(
            accessSchema,
            await this.#request(botId, "access", { conversationId: v.parse(identifier, conversationId) }, parent),
        );
    readonly createConversation = async (
        botId: string,
        conversationKey: string,
        settings: ChatDraftConfiguration,
        signal: AbortSignal,
    ): Promise<ChatAccess> =>
        v.parse(accessSchema, await this.#request(botId, "access", { conversationKey, ...settings }, signal));
    readonly draftSettings = async (botId: string, signal: AbortSignal) => {
        const result = v.parse(
            v.object({ bindingId: identifier, ready: v.unknown() }),
            await this.#request(botId, "draft-settings", {}, signal),
        );
        return {
            bindingId: result.bindingId,
            options: decodeSessionReadyEvent(JSON.stringify(result.ready)).configOptions,
        };
    };
    readonly createPairingInstruction = async (botId: string, signal: AbortSignal) => {
        const ticket = v.parse(
            v.object({ url: v.pipe(v.string(), v.url()), expiresAt: v.pipe(v.string(), v.isoTimestamp()) }),
            await this.#request(botId, "pairing-instruction", { botId }, signal),
        );
        const url = new URL(ticket.url);
        if (
            url.origin !== new URL(this.#origin).origin ||
            url.pathname !== "/pair.md" ||
            !/^mobius_pair_v2\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("token") ?? "")
        ) {
            throw new CloudApiError("INVALID_PAIRING_INSTRUCTION", "Pairing instruction is invalid.");
        }
        return ticket;
    };
    readonly connectConversation = async (botId: string, signal: AbortSignal, conversationId: string) => {
        const access = await this.access(botId, signal, conversationId);
        signal.throwIfAborted();
        let initial = true;
        return createMobiusConversationSession({
            projectId: this.#projectId,
            endpoint: access.endpoint,
            streamConnectionTimeoutMilliseconds: 45000,
            accessTokenProvider: {
                accessToken: async (parent) => {
                    const token = initial ? access : await this.access(botId, parent, conversationId);
                    initial = false;
                    if (token.endpoint !== access.endpoint || token.conversationId !== access.conversationId) {
                        throw new CloudApiError(
                            "CONVERSATION_CHANGED",
                            "The conversation identity changed. Reconnect to continue.",
                        );
                    }
                    return new MobiusBrowserAccessToken(token.credential, token.expiresAt);
                },
            },
        });
    };
    readonly workspace = async (botId: string, parent: AbortSignal): Promise<ChatWorkspace> =>
        v.parse(workspaceSchema, await this.#request(botId, "workspace", undefined, parent));
    readonly selectAgent = async (botId: string, selection: ChatAgentSelection, parent: AbortSignal): Promise<void> => {
        await this.#request(botId, "setup", v.parse(agentSelectionSchema, selection), parent);
    };
    readonly nativeSessions = async (
        botId: string,
        runtimeId: string,
        input: Parameters<MobiusClient["runtimes"]["nativeSessions"]>[1],
        signal: AbortSignal,
    ) =>
        decodeNativeSessionResult(
            JSON.stringify(await this.#request(botId, "native-sessions", { ...input, runtimeId }, signal)),
        );

    readonly connectSession = async (botId: string, sessionId: string, signal: AbortSignal): Promise<MobiusClient> => {
        const readAccess = async (parent: AbortSignal) =>
            v.parse(
                sessionAccessSchema,
                await this.#request(botId, "session-access", { sessionId: v.parse(identifier, sessionId) }, parent),
            );
        let access = await readAccess(signal);
        const endpoint = sessionEndpoint(access.endpoint);
        const projectId = access.projectId;
        if (access.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session could not be verified.");
        }
        return new MobiusClient({
            endpoint,
            projectId,
            operationTimeoutMilliseconds: 120000,
            credentialProvider: {
                credential: async (parent) => {
                    if (Date.parse(access.expiresAt) - Date.now() < 30000) {
                        access = await readAccess(parent);
                    }
                    if (
                        sessionEndpoint(access.endpoint) !== endpoint ||
                        access.projectId !== projectId ||
                        access.sessionId !== sessionId
                    ) {
                        throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session changed.");
                    }
                    return access.credential;
                },
            },
        });
    };
    readonly #request = async (
        botId: string,
        operation: string,
        body: unknown,
        parent: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([
            parent,
            AbortSignal.timeout(operation === "native-sessions" || operation === "draft-settings" ? 120000 : 45000),
        ]);
        const requestedBotId = v.parse(identifier, botId);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(
                    operation === "pairing-instruction"
                        ? "/mobius-cloud/api/identity/pairings"
                        : `/mobius-cloud/api/chat/bots/${encodeURIComponent(requestedBotId)}/${operation}`,
                    this.#origin,
                ),
                {
                    method: "POST",
                    signal,
                    redirect: "error",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                        "X-Mobius-Project-Id": this.#projectId,
                    },
                    body: body === undefined ? null : JSON.stringify(body),
                },
            ),
        );
        let value: unknown;
        try {
            value = await response.json();
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        signal.throwIfAborted();
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "CHAT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat is unavailable.",
            );
        }
        return value;
    };
}
