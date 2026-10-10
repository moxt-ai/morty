import {
    decodeAgentSettingsDiscoveredEvent,
    decodeNativeSessionEventsV2,
    decodeNativeSessionResult,
    decodeRuntimeDiagnosticsResult,
    decodeSessionReadyEvent,
    decodeSessionStatusChangedEvent,
    decodeWorkspaceEntriesEvent,
    type Identifier,
    isIdentifier,
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
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const accessSchema = v.pipe(
    v.strictObject({
        endpoint: v.pipe(v.string(), v.url()),
        projectId: identifier,
        conversationId: identifier,
        sessionId: identifier,
        credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/u)),
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        ready: v.unknown(),
        agentRef: identifier,
        workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
        instructions: v.pipe(v.string(), v.maxLength(100000)),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const managedSessionSchema = v.pipe(
    v.object({
        createdAt: v.pipe(v.string(), v.isoTimestamp()),
        isExternal: v.boolean(),
        id: identifier,
        title: v.string(),
        updatedAt: v.pipe(v.string(), v.isoTimestamp()),
        directoryLabel: v.string(),
        directoryId: v.string(),
        additionalDirectoryIds: v.array(v.string()),
        projectId: identifier,
        status: v.variant("kind", [
            v.pipe(v.object({ kind: v.literal("idle") }), v.readonly()),
            v.pipe(v.object({ commandId: identifier, kind: v.literal("working") }), v.readonly()),
        ]),
        userId: identifier,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
const chatRuntimeSchema = v.object({
    runtimeId: identifier,
    machineName: v.string(),
    online: v.boolean(),
    agents: v.array(
        v.object({
            agentRef: identifier,
            label: v.string(),
        }),
    ),
});
export type ChatRuntime = v.InferOutput<typeof chatRuntimeSchema>;
const workspaceSchema = v.object({ runtime: chatRuntimeSchema });
const networkDiagnosticSchema = v.strictObject({
    mobiusDaemonLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    mobiusOrigin: v.pipe(v.string(), v.url()),
    mortyMobiusLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type ChatWorkspace = v.InferOutput<typeof workspaceSchema>;
export type ChatAgentSelection = {
    readonly runtimeId: Identifier;
    readonly machineName: string;
    readonly agentRef: Identifier;
    readonly label: string;
};
export function connectedChatRuntimeAgents(runtime: ChatRuntime): readonly ChatAgentSelection[] {
    return runtime.online
        ? runtime.agents.map((agent) => ({
              runtimeId: runtime.runtimeId,
              machineName: runtime.machineName,
              ...agent,
          }))
        : [];
}
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
    credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/u)),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    endpoint: v.pipe(v.string(), v.url()),
});
const localSessionEntrySchema = v.object({
    entryId: identifier,
    mobiusSessionIds: v.array(identifier),
    nativeSessionId: identifier,
    title: v.string(),
    directoryId: v.string(),
    directoryLabel: v.string(),
    additionalDirectories: v.array(v.object({ directoryId: v.string(), name: v.string() })),
    updatedAt: v.nullable(v.string()),
});
const managedSdkSessionSchema = v.object({
    agentRef: identifier,
    instructions: v.string(),
    ready: v.unknown(),
    entry: localSessionEntrySchema,
});
const localSessionSchema = v.object({
    agentRef: identifier,
    instructions: v.string(),
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

    readonly #fetch = async (request: Request): Promise<Response> =>
        await (request.headers.get("accept")?.startsWith("text/event-stream") === true ||
        request.headers.get("accept") === "application/octet-stream"
            ? this.#http
            : this.#webSocket
        ).fetch(request);

    readonly fetch = async (request: Request): Promise<Response> => {
        const started = performance.now();
        const operation = new URL(request.url).pathname.split("/").slice(-1)[0] ?? "request";
        try {
            const response = await this.#fetch(request);
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "relay",
                operation,
                requestId: response.headers.get("x-request-id") ?? "",
                elapsedMs: Math.round(performance.now() - started),
                outcome: String(response.status),
            });
            return response;
        } catch (cause) {
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "relay",
                operation,
                requestId: "",
                elapsedMs: Math.round(performance.now() - started),
                outcome: request.signal.aborted ? "cancelled" : "error",
            });
            throw cause;
        }
    };

    readonly openLiveSessionEvents = async (request: Request): Promise<ReadableStream<MobiusTransportSessionEvent>> => {
        recordBrowserDiagnostic({
            at: new Date().toISOString(),
            component: "relay",
            operation: "live-events",
            outcome: "connecting",
            requestId: "",
            elapsedMs: 0,
        });
        try {
            const stream = await this.#webSocket.openLiveSessionEvents(request);
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "relay",
                operation: "live-events",
                outcome: "connected",
                requestId: "",
                elapsedMs: 0,
            });
            return stream;
        } catch (cause) {
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "relay",
                operation: "live-events",
                outcome: request.signal.aborted ? "cancelled" : "error",
                requestId: "",
                elapsedMs: 0,
            });
            throw cause;
        }
    };

    readonly close = (): void => this.#webSocket.close();
}

export class BotChatApi {
    readonly #agentSettingsCache = new Map<string, AgentSettingsResult>();
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #projectId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #sessionTransports = new Map<string, BrowserSessionTransport>();
    readonly #subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
    readonly #waitForChange: (request: Request) => Promise<void>;
    readonly listBots: ManagementApi["listBots"];
    readonly readBot: ManagementApi["readBot"];
    readonly createBot: ManagementApi["createBot"];
    readonly deleteBot: ManagementApi["deleteBot"];
    constructor(options: {
        readonly fetchRequest: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        readonly subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
        readonly waitForChange: (request: Request) => Promise<void>;
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#projectId = v.parse(identifier, options.projectId);
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#subscribe = options.subscribe;
        this.#waitForChange = options.waitForChange;
        const management = new ManagementApi(options);
        this.listBots = management.listBots;
        this.readBot = management.readBot;
        this.createBot = management.createBot;
        this.deleteBot = management.deleteBot;
    }
    readonly close = (): void => {
        for (const transport of this.#sessionTransports.values()) {
            transport.close();
        }
        this.#sessionTransports.clear();
    };
    readonly access = async (botId: string, parent: AbortSignal, conversationId: string): Promise<ChatAccess> =>
        v.parse(
            accessSchema,
            await this.#request(botId, "access", { conversationId: v.parse(identifier, conversationId) }, parent),
        );
    readonly daemonDiagnostics = async (botId: string, signal: AbortSignal) =>
        decodeRuntimeDiagnosticsResult(
            JSON.stringify(await this.#request(botId, "daemon-diagnostics", undefined, signal)),
        );
    readonly networkDiagnostic = async (botId: string, signal: AbortSignal) =>
        v.parse(networkDiagnosticSchema, await this.#request(botId, "network-diagnostic", undefined, signal));
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
    readonly conversationSession = (
        access: ChatAccess,
        activeTurn: ConversationActiveTurn,
        directoryLabel = access.workspaceRef,
        title = "Untitled session",
    ) => ({
        agentRef: access.agentRef,
        instructions: access.instructions,
        result: {
            action: "conversation" as const,
            access,
            activeTurn,
            targetSessionId: access.sessionId,
            ready: decodeSessionReadyEvent(JSON.stringify(access.ready)),
        },
        entry: {
            entryId: access.sessionId,
            mobiusSessionIds: [access.sessionId],
            nativeSessionId: access.sessionId,
            title,
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
    readonly subscribeManagedSessionStatuses = async (
        botId: string,
        receive: (event: ReturnType<typeof decodeSessionStatusChangedEvent>) => void,
        signal: AbortSignal,
    ): Promise<void> => {
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#subscribe(
            new Request(
                new URL(
                    `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(v.parse(identifier, botId))}/managed-session/status-events`,
                    this.#origin,
                ),
                { method: "POST", headers: { authorization: `Bearer ${token}` }, signal },
            ),
            (data) => receive(decodeSessionStatusChangedEvent(data)),
        );
    };
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
            instructions: stored.instructions,
            entry: stored.entry,
            result: {
                action: "managed" as const,
                targetSessionId: sessionId,
                ready,
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
        return {
            ...stored,
            result,
        };
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
    readonly #waitForBotChange = async (
        botId: string,
        resource: "setup/runtimes" | "workspace",
        parent: AbortSignal,
    ) => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#waitForChange(
            new Request(
                new URL(
                    `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(v.parse(identifier, botId))}/${resource}`,
                    this.#origin,
                ),
                { method: "POST", headers: { authorization: `Bearer ${token}` }, signal },
            ),
        );
    };
    readonly waitForSetupChange = async (botId: string, parent: AbortSignal): Promise<void> =>
        await this.#waitForBotChange(botId, "setup/runtimes", parent);
    readonly waitForWorkspaceChange = async (botId: string, parent: AbortSignal): Promise<void> =>
        await this.#waitForBotChange(botId, "workspace", parent);
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
            readonly agentId: string;
            readonly directoryId: string;
            readonly additionalDirectoryIds: readonly string[];
            readonly nativeSessionId: string;
        },
        signal: AbortSignal,
    ) => {
        const { entryId, ...identity } = input;
        return decodeNativeSessionEventsV2(
            await this.#request(
                botId,
                `native-session/${encodeURIComponent(v.parse(identifier, entryId))}`,
                { ...identity, runtimeId },
                signal,
            ),
        );
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
        let sharedTransport = this.#sessionTransports.get(endpoint);
        if (sharedTransport === undefined) {
            sharedTransport = new BrowserSessionTransport();
            this.#sessionTransports.set(endpoint, sharedTransport);
        }
        return new MobiusClient({
            endpoint,
            projectId,
            operationTimeoutMilliseconds: 120000,
            transport: sharedTransport,
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
