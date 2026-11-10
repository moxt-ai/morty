import {
    HttpTransport,
    MortyClient,
    type MortyHttpTransport,
    type MortyLiveEventTransport,
    type MortyTransportSessionEvent,
    WsTransport,
} from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeAgentSettingsDiscoveredEvent,
    decodeNativeSessionEvents,
    decodeNativeSessionResult,
    decodeRuntimeDiagnosticsResult,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    type Identifier,
    isDirectoryPath,
    isIdentifier,
    type NativeSessionTarget,
    type SessionConfigOption,
    type SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import type { ApiResponseSnapshot, ApiTransport } from "../api/api-transport.ts";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { type AgentModelCatalog, modelSelections } from "../diagnostics/model-catalog.ts";
import { CloudApiError, ManagementApi, machineUrl } from "../management/management-api.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const nativeSessionTargetSchema = v.pipe(v.strictObject({ harness: identifier, sessionId: identifier }), v.readonly());
const accessSchema = v.pipe(
    v.strictObject({
        endpoint: v.pipe(v.string(), v.url()),
        computerId: identifier,
        target: nativeSessionTargetSchema,
        credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/u)),
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        ready: v.unknown(),
        harness: identifier,
        workspaceRef: v.custom<string>(isDirectoryPath),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const managedSessionStatusSchema = v.variant("kind", [
    v.pipe(
        v.object({
            kind: v.literal("idle"),
            /** The Runtime's account that the Session's last turn failed; Runtimes before it existed omit it. */
            failedTurn: v.optional(
                v.pipe(v.object({ code: v.string(), commandId: identifier, message: v.string() }), v.readonly()),
            ),
        }),
        v.readonly(),
    ),
    v.pipe(v.object({ commandId: identifier, kind: v.literal("working") }), v.readonly()),
]);
/** A Session the computer's Runtime holds, as the Runtime describes it. */
const managedSessionSchema = v.pipe(
    v.object({
        title: v.string(),
        updatedAt: v.pipe(v.string(), v.isoTimestamp()),
        directoryLabel: v.string(),
        directory: v.string(),
        /** Whether the Runtime has received the Session's first prompt, which gives the Session its title. */
        prompted: v.boolean(),
        target: nativeSessionTargetSchema,
        status: managedSessionStatusSchema,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
const chatRuntimeSchema = v.object({
    computerId: identifier,
    machineName: v.string(),
    online: v.boolean(),
    agents: v.array(
        v.object({
            harness: identifier,
            label: v.string(),
        }),
    ),
});
export type ChatRuntime = v.InferOutput<typeof chatRuntimeSchema>;
const runtimeConfigurationSchema = v.object({ runtime: chatRuntimeSchema });
const networkDiagnosticSchema = v.strictObject({
    relayRuntimeLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    relayOrigin: v.pipe(v.string(), v.url()),
    mortyRelayLatencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type BotRuntimeConfiguration = v.InferOutput<typeof runtimeConfigurationSchema>;
export type ChatAgentSelection = {
    readonly computerId: Identifier;
    readonly machineName: string;
    readonly harness: Identifier;
    readonly label: string;
};
/**
 * Whether the Runtime can take a new conversation now. The setup notice and the draft's settings both follow this one
 * rule, so they never disagree about why a draft cannot start.
 */
export function runtimeAgentAvailability(runtime: ChatRuntime): "no-agent" | "offline" | "available" {
    if (runtime.agents.length === 0) {
        return "no-agent";
    }
    return runtime.online ? "available" : "offline";
}
export function connectedChatRuntimeAgents(runtime: ChatRuntime): readonly ChatAgentSelection[] {
    return runtime.online
        ? runtime.agents.map((agent) => ({
              computerId: runtime.computerId,
              machineName: runtime.machineName,
              ...agent,
          }))
        : [];
}
export interface ChatDraftConfiguration {
    readonly harness: string;
    readonly workspaceRef: string;
    readonly workspaceLabel: string;
    readonly configurations: readonly SessionConfigurationSelection[];
}
interface AgentSettingsResult {
    readonly options: readonly SessionConfigOption[];
    readonly catalog: AgentModelCatalog;
}
export type ConversationActiveTurn =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly commandId: string; readonly turnId: string };
const sessionAccessSchema = v.object({
    target: nativeSessionTargetSchema,
    computerId: identifier,
    credential: v.pipe(v.string(), v.regex(/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/u)),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    endpoint: v.pipe(v.string(), v.url()),
});
const localSessionEntrySchema = v.object({
    sessionId: identifier,
    title: v.string(),
    directory: v.string(),
    directoryLabel: v.string(),
    updatedAt: v.nullable(v.string()),
});
const managedSdkSessionSchema = v.object({
    harness: identifier,
    ready: v.unknown(),
    entry: localSessionEntrySchema,
});
const localSessionSchema = v.object({
    harness: identifier,
    result: v.unknown(),
    entry: localSessionEntrySchema,
});

function continuedSession(value: unknown) {
    const stored = v.parse(localSessionSchema, value);
    const result = decodeNativeSessionResult(JSON.stringify(stored.result));
    if (result.action !== "import") {
        throw new CloudApiError("INVALID_SESSION", "The continued Chat session is invalid.");
    }
    return { ...stored, result };
}

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

class BrowserSessionTransport implements MortyHttpTransport, MortyLiveEventTransport {
    readonly #http = new HttpTransport();
    #webSocket = new WsTransport();

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

    readonly openSessionLiveEvents = async (request: Request): Promise<ReadableStream<MortyTransportSessionEvent>> => {
        recordBrowserDiagnostic({
            at: new Date().toISOString(),
            component: "relay",
            operation: "live-events",
            outcome: "connecting",
            requestId: "",
            elapsedMs: 0,
        });
        try {
            const stream = await this.#webSocket.openSessionLiveEvents(request);
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

    readonly reset = (): void => {
        const previous = this.#webSocket;
        this.#webSocket = new WsTransport();
        previous.close();
    };
    readonly close = (): void => this.#webSocket.close();
}

export class BotChatApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #computerId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #replacedToken: ((rejected: string, signal: AbortSignal) => Promise<string | null>) | undefined;
    readonly #credentialRejected: (() => void) | undefined;
    readonly #sessionTransport = new BrowserSessionTransport();
    readonly #waitForChange: ApiTransport["waitForChange"];
    readonly readRuntimePairing: ManagementApi["readRuntimePairing"];
    constructor(options: {
        readonly fetchRequest: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly computerId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        /**
         * The access that replaced `rejected`, once whoever replaces it has finished, or null when nothing did. A
         * request refused while another tab replaced its access is sent again with the replacement.
         */
        readonly replacedToken?: (rejected: string, signal: AbortSignal) => Promise<string | null>;
        /** Told when the Worker refuses the access as unauthenticated; whoever owns that access decides what it means. */
        readonly credentialRejected?: () => void;
        readonly waitForChange: ApiTransport["waitForChange"];
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#computerId = v.parse(identifier, options.computerId);
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#replacedToken = options.replacedToken;
        this.#credentialRejected = options.credentialRejected;
        this.#waitForChange = options.waitForChange;
        const management = new ManagementApi(options);
        this.readRuntimePairing = management.readRuntimePairing;
    }
    readonly resetSessionConnections = (): void => {
        this.#sessionTransport.reset();
    };
    readonly close = (): void => {
        this.#sessionTransport.close();
    };
    readonly access = async (parent: AbortSignal, target: NativeSessionTarget): Promise<ChatAccess> =>
        v.parse(accessSchema, await this.#request("access", v.parse(nativeSessionTargetSchema, target), parent));
    readonly daemonDiagnostics = async (signal: AbortSignal) =>
        decodeRuntimeDiagnosticsResult(JSON.stringify(await this.#request("daemon-diagnostics", undefined, signal)));
    readonly networkDiagnostic = async (signal: AbortSignal) =>
        v.parse(networkDiagnosticSchema, await this.#request("network-diagnostic", undefined, signal));
    readonly createConversation = async (
        conversationKey: string,
        settings: ChatDraftConfiguration,
        signal: AbortSignal,
    ): Promise<ChatAccess> =>
        v.parse(
            accessSchema,
            await this.#request(
                "access",
                {
                    harness: settings.harness,
                    configurations: settings.configurations,
                    conversationKey,
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
        harness: access.harness,
        result: {
            action: "conversation" as const,
            access,
            activeTurn,
            target: access.target,
            ready: decodeSessionReadyEvent(JSON.stringify(access.ready)),
        },
        entry: {
            sessionId: access.target.sessionId,
            title,
            directory: access.workspaceRef,
            directoryLabel,
            updatedAt: null,
        },
    });
    readonly managedSessions = async (signal: AbortSignal) =>
        v.parse(
            v.object({ sessions: v.array(managedSessionSchema) }),
            await this.#request("managed-sessions", {}, signal),
        ).sessions;
    /** Resolves once the Runtime no longer holds the Session; otherwise rejects with the Runtime's failure. */
    readonly archiveManagedSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> => {
        v.parse(
            v.object({ target: nativeSessionTargetSchema }),
            await this.#request("managed-session/archive", v.parse(nativeSessionTargetSchema, target), signal),
        );
    };
    readonly managedSession = async (target: NativeSessionTarget, signal: AbortSignal) => {
        const stored = v.parse(
            managedSdkSessionSchema,
            await this.#request("managed-session", v.parse(nativeSessionTargetSchema, target), signal),
        );
        const ready = decodeSessionReadyEvent(JSON.stringify(stored.ready));
        if (ready.harness !== target.harness || stored.entry.sessionId !== target.sessionId) {
            throw new CloudApiError("INVALID_SESSION", "The saved Chat session is invalid.");
        }
        return {
            harness: stored.harness,
            entry: stored.entry,
            result: {
                action: "managed" as const,
                target: ready.target,
                ready,
            },
        };
    };
    /** Imports the native session a setup handoff names into the caller's Machine. */
    readonly continueNativeSession = async (harness: string, sessionId: string, signal: AbortSignal) =>
        continuedSession(await this.#request("continue-native-session", { harness, sessionId }, signal));
    /** The settings a new Session of the Agent starts with in the directory. */
    readonly agentSettings = async (
        harness: string,
        workspaceRef: string,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        signal.throwIfAborted();
        const requestedHarness = v.parse(identifier, harness);
        const result = v.parse(
            v.object({ settings: v.unknown() }),
            await this.#request("agent-settings", { harness: requestedHarness, workspaceRef }, signal),
        );
        const discovered = decodeAgentSettingsDiscoveredEvent(JSON.stringify(result.settings));
        const settings = {
            catalog: {
                harness: discovered.harness,
                agentVersion: discovered.agentVersion,
                observedAt: new Date().toISOString(),
                revision: discovered.settingsRevision,
                requestId: discovered.requestId,
                models: modelSelections(
                    discovered.settings.map((setting) => ({ ...setting, currentValue: setting.defaultValue })),
                ),
            },
            options: discovered.settings.map(({ defaultValue, ...setting }) => ({
                ...setting,
                currentValue:
                    setting.type === "select" && !setting.values.some((value) => value.value === defaultValue)
                        ? (setting.values[0]?.value ?? "")
                        : defaultValue,
            })),
        };
        return settings;
    };
    readonly runtimeConfiguration = async (parent: AbortSignal): Promise<BotRuntimeConfiguration> =>
        v.parse(runtimeConfigurationSchema, await this.#request("workspace", undefined, parent));
    readonly directory = async (directory: string, signal: AbortSignal) =>
        decodeWorkspaceEntriesEvent(JSON.stringify(await this.#request("workspace/directory", { directory }, signal)));
    /** Resolves once the watched resource differs from the snapshot this client last read, or from its first sample. */
    readonly #waitForResourceChange = async (
        url: URL,
        method: "GET" | "POST",
        parent: AbortSignal,
        onReady?: (snapshot: ApiResponseSnapshot) => void,
    ) => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#waitForChange(
            new Request(url, { method, headers: { authorization: `Bearer ${token}` }, signal }),
            onReady,
        );
    };
    /** Resolves once the Machine's Runtime pairing differs from the pairing this client last read. */
    readonly waitForRuntimePairingChange = async (parent: AbortSignal): Promise<void> =>
        await this.#waitForResourceChange(machineUrl(this.#origin, this.#computerId), "GET", parent);
    readonly waitForRuntimeConfigurationChange = async (
        parent: AbortSignal,
        onReady?: (configuration: BotRuntimeConfiguration) => void,
    ): Promise<void> =>
        await this.#waitForResourceChange(
            new URL(`/morty/api/chat/computers/${encodeURIComponent(this.#computerId)}/workspace`, this.#origin),
            "POST",
            parent,
            onReady === undefined
                ? undefined
                : (snapshot) => {
                      const value = this.#readResponse(snapshot, parent);
                      onReady(v.parse(runtimeConfigurationSchema, value));
                  },
        );
    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: Parameters<MortyClient["runtimes"]["forkNativeSession"]>[1],
        signal: AbortSignal,
    ) =>
        decodeNativeSessionResult(
            JSON.stringify(
                await this.#request(
                    `native-session-forks/${encodeURIComponent(operationId)}`,
                    { ...input, computerId },
                    signal,
                ),
            ),
        );

    readonly nativeSessions = async (
        computerId: string,
        input: Parameters<MortyClient["runtimes"]["nativeSessions"]>[0],
        signal: AbortSignal,
    ) => {
        if (input.action === "list") {
            return decodeNativeSessionResult(
                JSON.stringify(await this.#request("native-sessions", { ...input, computerId }, signal)),
            );
        }
        if (input.action !== "import") {
            throw new CloudApiError(
                "INVALID_REQUEST",
                "Fork through forkNativeSession and read local history through the session preview endpoint.",
            );
        }
        const { sessionId, action, ...identity } = input;
        return decodeNativeSessionResult(
            JSON.stringify(
                await this.#request(
                    `native-session/${encodeURIComponent(v.parse(identifier, sessionId))}/${action}`,
                    { ...identity, computerId },
                    signal,
                ),
            ),
        );
    };
    readonly nativeSession = async (
        computerId: string,
        input: {
            readonly harness: string;
            readonly directory: string;
            readonly sessionId: string;
        },
        signal: AbortSignal,
    ) => {
        const { sessionId, ...identity } = input;
        return decodeNativeSessionEvents(
            await this.#request(
                `native-session/${encodeURIComponent(v.parse(identifier, sessionId))}`,
                { ...identity, computerId },
                signal,
            ),
        );
    };

    readonly connectSession = async (
        target: NativeSessionTarget,
        signal: AbortSignal,
        initialAccess?: ChatAccess,
    ): Promise<MortyClient> => {
        const readAccess = async (parent: AbortSignal) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return v.parse(
                        sessionAccessSchema,
                        await this.#request("session-access", v.parse(nativeSessionTargetSchema, target), parent),
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
        const computerId = access.computerId;
        if (!sameNativeSession(access.target, target)) {
            throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session could not be verified.");
        }
        return new MortyClient({
            endpoint,
            computerId,
            operationTimeoutMilliseconds: 120000,
            maxStreamReconnectAttempts: 0,
            transport: this.#sessionTransport,
            credentialProvider: {
                credential: async (parent) => {
                    if (Date.parse(access.expiresAt) - Date.now() < 30000) {
                        access = await readAccess(parent);
                    }
                    if (
                        sessionEndpoint(access.endpoint) !== endpoint ||
                        access.computerId !== computerId ||
                        !sameNativeSession(access.target, target)
                    ) {
                        throw new CloudApiError("INVALID_SESSION_ACCESS", "The selected Session changed.");
                    }
                    return access.credential;
                },
            },
        });
    };
    readonly #request = async (operation: string, body: unknown, parent: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([
            parent,
            AbortSignal.timeout(
                // Native Session work, including continuing one, has the Worker's 120s budget; a shorter wait
                // would abandon, and the home load would retry, a request still running there.
                operation.startsWith("native-session") ||
                    operation.startsWith("continue-native-session") ||
                    operation === "agent-settings"
                    ? 120000
                    : 45000,
            ),
        ]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const send = (access: string) =>
            this.#fetchRequest(
                new Request(
                    new URL(
                        `/morty/api/chat/computers/${encodeURIComponent(this.#computerId)}/${operation}`,
                        this.#origin,
                    ),
                    {
                        method: "POST",
                        signal,
                        redirect: "error",
                        headers: {
                            authorization: `Bearer ${access}`,
                            "content-type": "application/json",
                        },
                        body: body === undefined ? null : JSON.stringify(body),
                    },
                ),
            );
        let response = await send(token);
        if (response.status === 401 && this.#replacedToken !== undefined) {
            const replacement = await this.#replacedToken(token, signal);
            if (replacement !== null) {
                await response.body?.cancel();
                response = await send(replacement);
            }
        }
        if (response.status === 401) {
            this.#credentialRejected?.();
        }
        let responseBody: string;
        try {
            responseBody = await response.text();
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        return this.#readResponse({ status: response.status, headers: response.headers, body: responseBody }, signal);
    };
    readonly #readResponse = (response: ApiResponseSnapshot, signal: AbortSignal): unknown => {
        signal.throwIfAborted();
        let value: unknown;
        try {
            value = JSON.parse(response.body);
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        signal.throwIfAborted();
        if (response.status < 200 || response.status >= 300) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "CHAT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat is unavailable.",
                response.status,
                response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "",
            );
        }
        return value;
    };
}
