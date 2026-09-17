import {
    decodeAgentSettingsDiscoveredEvent,
    decodeNativeSessionHistory,
    decodeNativeSessionResult,
} from "@moxt-ai/mobius-protocol";
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
const managedSessionSchema = v.pipe(
    v.object({
        kind: v.picklist(["conversation", "fork", "import"]),
        id: identifier,
        title: v.string(),
        projectId: identifier,
        userId: identifier,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
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
const localSessionSchema = v.object({
    agentRef: identifier,
    result: v.unknown(),
    entry: v.object({
        entryId: identifier,
        title: v.string(),
        directoryId: v.string(),
        directoryLabel: v.string(),
        additionalDirectories: v.array(v.object({ directoryId: v.string(), name: v.string() })),
        updatedAt: v.nullable(v.string()),
    }),
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
        title = "New chat",
    ): Promise<ChatAccess> =>
        v.parse(accessSchema, await this.#request(botId, "access", { conversationKey, ...settings, title }, signal));
    readonly managedSessions = async (botId: string, signal: AbortSignal) =>
        v.parse(
            v.object({ sessions: v.array(managedSessionSchema) }),
            await this.#request(botId, "managed-sessions", {}, signal),
        ).sessions;
    readonly managedSession = async (botId: string, sessionId: string, signal: AbortSignal) => {
        const stored = v.parse(
            localSessionSchema,
            await this.#request(botId, "managed-session", { sessionId }, signal),
        );
        const result = decodeNativeSessionResult(JSON.stringify(stored.result));
        if ((result.action !== "fork" && result.action !== "import") || result.ready.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The saved Chat session is invalid.");
        }
        return { ...stored, result };
    };
    readonly continueNativeSession = async (botId: string, harness: string, sessionId: string, signal: AbortSignal) => {
        const stored = v.parse(
            localSessionSchema,
            await this.#request(botId, "continue-native-session", { harness, sessionId }, signal),
        );
        const result = decodeNativeSessionResult(JSON.stringify(stored.result));
        if (result.action !== "fork" || result.ready.sessionId !== result.targetSessionId) {
            throw new CloudApiError("INVALID_SESSION", "The continued Chat session is invalid.");
        }
        const action: "fork" = result.action;
        return { ...stored, result: { ...result, action } };
    };
    readonly agentSettings = async (botId: string, signal: AbortSignal) => {
        const result = v.parse(
            v.object({ bindingId: identifier, settings: v.unknown() }),
            await this.#request(botId, "agent-settings", {}, signal),
        );
        return {
            bindingId: result.bindingId,
            options: decodeAgentSettingsDiscoveredEvent(JSON.stringify(result.settings)).configOptions,
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
    readonly connectConversation = (botId: string, signal: AbortSignal, access: ChatAccess) => {
        signal.throwIfAborted();
        const conversationId = access.conversationId;
        let initial = true;
        let current = access;
        return createMobiusConversationSession({
            projectId: this.#projectId,
            endpoint: current.endpoint,
            streamConnectionTimeoutMilliseconds: 45000,
            accessTokenProvider: {
                accessToken: async (parent) => {
                    const token = initial ? current : await this.access(botId, parent, conversationId);
                    initial = false;
                    current = token;
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
    ) => {
        if (input.action === "list") {
            return decodeNativeSessionResult(
                JSON.stringify(await this.#request(botId, "native-sessions", { ...input, runtimeId }, signal)),
            );
        }
        if (input.action !== "fork" && input.action !== "import") {
            throw new CloudApiError("INVALID_REQUEST", "Use the session preview endpoint to read local history.");
        }
        const { entryId, action, ...identity } = input;
        return decodeNativeSessionResult(
            JSON.stringify(
                await this.#request(
                    botId,
                    `native-session/${encodeURIComponent(v.parse(identifier, entryId))}/${action}`,
                    { ...identity, runtimeId },
                    signal,
                ),
            ),
        );
    };
    readonly nativeSession = async (
        botId: string,
        runtimeId: string,
        input: {
            readonly entryId: string;
            readonly discoveryId: string;
            readonly agentId: string;
            readonly directoryId: string;
            readonly additionalDirectoryIds: readonly string[];
        },
        signal: AbortSignal,
    ) => {
        const { entryId, ...identity } = input;
        const result = v.parse(
            v.object({ title: v.string(), history: v.unknown() }),
            await this.#request(
                botId,
                `native-session/${encodeURIComponent(v.parse(identifier, entryId))}`,
                { ...identity, runtimeId },
                signal,
            ),
        );
        return { title: result.title, history: decodeNativeSessionHistory(result.history) };
    };

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
            AbortSignal.timeout(
                operation.startsWith("native-session") || operation === "agent-settings" ? 120000 : 45000,
            ),
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
                        ? `/mobius-cloud/api/projects/${encodeURIComponent(this.#projectId)}/identity/pairings`
                        : `/mobius-cloud/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(requestedBotId)}/${operation}`,
                    this.#origin,
                ),
                {
                    method: "POST",
                    signal,
                    redirect: "error",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
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
