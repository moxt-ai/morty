import {
    decodeAgentSettingsDiscoveredEvent,
    decodeNativeSessionHistory,
    decodeNativeSessionResult,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    type SessionConfigOption,
    type SessionConfigurationSelection,
} from "@moxt-ai/mobius-protocol";
import {
    HttpTransport,
    MobiusClient,
    type MobiusHttpTransport,
    type MobiusLiveEventTransport,
    type MobiusTransportSessionEvent,
    WsTransport,
} from "@moxt-ai/mobius-sdk";
import * as v from "valibot";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const accessSchema = v.pipe(
    v.strictObject({
        endpoint: v.pipe(v.string(), v.url()),
        projectId: identifier,
        conversationId: identifier,
        sessionId: identifier,
        credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u)),
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        ready: v.unknown(),
        agentRef: identifier,
        workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const managedSessionSchema = v.pipe(
    v.object({
        isExternal: v.boolean(),
        id: identifier,
        title: v.string(),
        directoryLabel: v.string(),
        projectId: identifier,
        userId: identifier,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
const workspaceSchema = v.object({
    status: v.string(),
    runtimeId: v.nullable(identifier),
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
export interface ChatDraftConfiguration {
    readonly agentRef: string;
    readonly workspaceRef: string;
    readonly workspaceLabel: string;
    readonly configurations: readonly SessionConfigurationSelection[];
}
interface AgentSettingsResult {
    readonly options: readonly SessionConfigOption[];
}
export type ConversationActiveTurn =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly commandId: string; readonly turnId: string };
const sessionAccessSchema = v.object({
    sessionId: identifier,
    projectId: identifier,
    credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u)),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    endpoint: v.pipe(v.string(), v.url()),
});
const localSessionEntrySchema = v.object({
    entryId: identifier,
    title: v.string(),
    directoryId: v.string(),
    directoryLabel: v.string(),
    additionalDirectories: v.array(v.object({ directoryId: v.string(), name: v.string() })),
    updatedAt: v.nullable(v.string()),
});
const managedSdkSessionSchema = v.object({
    agentRef: identifier,
    ready: v.unknown(),
    entry: localSessionEntrySchema,
});
const localSessionSchema = v.object({
    agentRef: identifier,
    result: v.unknown(),
    entry: localSessionEntrySchema,
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

class BrowserSessionTransport implements MobiusHttpTransport, MobiusLiveEventTransport {
    readonly #http = new HttpTransport();
    readonly #webSocket = new WsTransport();

    readonly fetch = async (request: Request): Promise<Response> =>
        await (request.headers.get("accept")?.startsWith("text/event-stream") === true ||
        request.headers.get("accept") === "application/octet-stream"
            ? this.#http
            : this.#webSocket
        ).fetch(request);

    readonly openLiveSessionEvents = async (request: Request): Promise<ReadableStream<MobiusTransportSessionEvent>> =>
        await this.#webSocket.openLiveSessionEvents(request);

    readonly close = (): void => this.#webSocket.close();
}

class BrowserSessionClient implements MobiusClient {
    readonly attempts: MobiusClient["attempts"];
    readonly capabilities: MobiusClient["capabilities"];
    readonly credentials: MobiusClient["credentials"];
    readonly events: MobiusClient["events"];
    readonly interactions: MobiusClient["interactions"];
    readonly runtimePairings: MobiusClient["runtimePairings"];
    readonly runtimes: MobiusClient["runtimes"];
    readonly sessions: MobiusClient["sessions"];
    readonly #sessionTransport: BrowserSessionTransport;
    readonly toolCalls: MobiusClient["toolCalls"];
    readonly turns: MobiusClient["turns"];
    readonly #client: MobiusClient;

    constructor(options: ConstructorParameters<typeof MobiusClient>[0], transport: BrowserSessionTransport) {
        const client = new MobiusClient(options);
        this.#client = client;
        this.#sessionTransport = transport;
        this.attempts = client.attempts;
        this.capabilities = client.capabilities;
        this.credentials = client.credentials;
        this.events = client.events;
        this.interactions = client.interactions;
        this.runtimePairings = client.runtimePairings;
        this.runtimes = client.runtimes;
        this.sessions = client.sessions;
        this.toolCalls = client.toolCalls;
        this.turns = client.turns;
    }

    readonly close = (): void => {
        this.#client.close();
        this.#sessionTransport.close();
    };
}

export class BotChatApi {
    readonly #agentSettingsCache = new Map<string, AgentSettingsResult>();
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #projectId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #waitForChange: (request: Request) => Promise<void>;
    readonly listBots: ManagementApi["listBots"];
    readonly createBot: ManagementApi["createBot"];
    readonly deleteBot: ManagementApi["deleteBot"];
    constructor(options: {
        readonly fetchRequest: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        readonly waitForChange: (request: Request) => Promise<void>;
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#projectId = v.parse(identifier, options.projectId);
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#waitForChange = options.waitForChange;
        const management = new ManagementApi(options);
        this.listBots = management.listBots;
        this.createBot = management.createBot;
        this.deleteBot = management.deleteBot;
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
        v.parse(
            accessSchema,
            await this.#request(
                botId,
                "access",
                {
                    agentRef: settings.agentRef,
                    configurations: settings.configurations,
                    conversationKey,
                    title,
                    workspaceRef: settings.workspaceRef,
                },
                signal,
            ),
        );
    readonly submitTurn = async (
        botId: string,
        sessionId: string,
        request: Parameters<MobiusClient["turns"]["submit"]>[1],
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> =>
        v.parse(
            v.object({ turnId: identifier }),
            await this.#request(botId, "turns", { sessionId: v.parse(identifier, sessionId), ...request }, signal),
        );
    readonly steerTurn = async (
        botId: string,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#request(
            botId,
            "turns/steer",
            { sessionId: v.parse(identifier, sessionId), turnId: v.parse(identifier, turnId) },
            signal,
        );
    };
    readonly conversationSession = (
        access: ChatAccess,
        activeTurn: ConversationActiveTurn,
        directoryLabel = access.workspaceRef,
    ) => ({
        agentRef: access.agentRef,
        result: {
            action: "conversation" as const,
            access,
            activeTurn,
            targetSessionId: access.sessionId,
            ready: decodeSessionReadyEvent(JSON.stringify(access.ready)),
            history: {
                status: "unavailable" as const,
                cause: {
                    code: "native_history_not_requested",
                    message: "Native message history has not been requested yet.",
                },
            },
        },
        entry: {
            entryId: access.sessionId,
            title: "",
            directoryId: access.workspaceRef,
            directoryLabel,
            additionalDirectories: [],
            updatedAt: null,
        },
    });
    readonly managedSessions = async (botId: string, signal: AbortSignal) =>
        v.parse(
            v.object({ sessions: v.array(managedSessionSchema) }),
            await this.#request(botId, "managed-sessions", {}, signal),
        ).sessions;
    readonly archiveManagedSession = async (botId: string, sessionId: string, signal: AbortSignal): Promise<void> => {
        v.parse(
            v.object({}),
            await this.#request(
                botId,
                "managed-session/archive",
                { sessionId: v.parse(identifier, sessionId) },
                signal,
            ),
        );
    };
    readonly managedSession = async (botId: string, sessionId: string, signal: AbortSignal) => {
        const stored = v.parse(
            managedSdkSessionSchema,
            await this.#request(botId, "managed-session", { sessionId }, signal),
        );
        const ready = decodeSessionReadyEvent(JSON.stringify(stored.ready));
        if (ready.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The saved Chat session is invalid.");
        }
        return {
            agentRef: stored.agentRef,
            entry: stored.entry,
            result: {
                action: "managed" as const,
                targetSessionId: sessionId,
                ready,
                history: {
                    status: "unavailable" as const,
                    cause: { code: "history_loading", message: "Session history will load after connecting." },
                },
            },
        };
    };
    readonly continueNativeSession = async (
        botId: string,
        harness: string,
        sessionId: string,
        action: "fork" | "import",
        signal: AbortSignal,
    ) => {
        const stored = v.parse(
            localSessionSchema,
            await this.#request(botId, "continue-native-session", { action, harness, sessionId }, signal),
        );
        const result = decodeNativeSessionResult(JSON.stringify(stored.result));
        if (result.action !== action || result.ready.sessionId !== result.targetSessionId) {
            throw new CloudApiError("INVALID_SESSION", "The continued Chat session is invalid.");
        }
        return { ...stored, result };
    };
    readonly agentSettings = async (
        botId: string,
        agentRef: string,
        refresh: boolean,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        signal.throwIfAborted();
        const requestedBotId = v.parse(identifier, botId);
        const requestedAgentRef = v.parse(identifier, agentRef);
        const cacheKey = JSON.stringify([requestedBotId, requestedAgentRef]);
        if (refresh) {
            this.#agentSettingsCache.delete(cacheKey);
        } else {
            const cached = this.#agentSettingsCache.get(cacheKey);
            if (cached !== undefined) {
                return cached;
            }
        }
        const result = v.parse(
            v.object({ settings: v.unknown() }),
            await this.#request(requestedBotId, "agent-settings", { agentRef: requestedAgentRef }, signal),
        );
        const discovered = decodeAgentSettingsDiscoveredEvent(JSON.stringify(result.settings));
        const settings = {
            options: discovered.settings.map(({ defaultValue, ...setting }) => ({
                ...setting,
                currentValue:
                    setting.type === "select" && !setting.values.some((value) => value.value === defaultValue)
                        ? (setting.values[0]?.value ?? "")
                        : defaultValue,
            })),
        };
        this.#agentSettingsCache.set(cacheKey, settings);
        return settings;
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
    readonly workspace = async (botId: string, parent: AbortSignal): Promise<ChatWorkspace> =>
        v.parse(workspaceSchema, await this.#request(botId, "workspace", undefined, parent));
    readonly workspaceDirectory = async (botId: string, directoryId: string, signal: AbortSignal) =>
        decodeWorkspaceEntriesEvent(
            JSON.stringify(await this.#request(botId, "workspace/directory", { directoryId }, signal)),
        );
    readonly waitForWorkspaceChange = async (botId: string, parent: AbortSignal): Promise<void> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#waitForChange(
            new Request(
                new URL(
                    `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(v.parse(identifier, botId))}/workspace`,
                    this.#origin,
                ),
                { method: "POST", headers: { authorization: `Bearer ${token}` }, signal },
            ),
        );
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

    readonly connectSession = async (
        botId: string,
        sessionId: string,
        signal: AbortSignal,
        initialAccess?: ChatAccess,
    ): Promise<MobiusClient> => {
        const readAccess = async (parent: AbortSignal) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return v.parse(
                        sessionAccessSchema,
                        await this.#request(
                            botId,
                            "session-access",
                            { sessionId: v.parse(identifier, sessionId) },
                            parent,
                        ),
                    );
                } catch (cause) {
                    parent.throwIfAborted();
                    if (!(cause instanceof CloudApiError) || cause.code !== "CHAT_UNAVAILABLE" || attempt === 1) {
                        throw cause;
                    }
                }
            }
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat is unavailable.");
        };
        let access = initialAccess ?? (await readAccess(signal));
        const endpoint = sessionEndpoint(access.endpoint);
        const projectId = access.projectId;
        if (access.sessionId !== sessionId) {
            throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session could not be verified.");
        }
        const transport = new BrowserSessionTransport();
        return new BrowserSessionClient(
            {
                endpoint,
                projectId,
                operationTimeoutMilliseconds: 120000,
                transport,
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
            },
            transport,
        );
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
                        ? `/morty/api/projects/${encodeURIComponent(this.#projectId)}/identity/pairings`
                        : `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(requestedBotId)}/${operation}`,
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
                response.status,
            );
        }
        return value;
    };
}
