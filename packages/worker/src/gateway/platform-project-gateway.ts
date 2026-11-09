import {
    MortyApiError,
    MortyAppCredentialProvider,
    MortyCancellationError,
    MortyError,
    MortyPlatformAppClient,
    MortyTimeoutError,
} from "@morty-build/client/platform";
import { decodeRuntimeDiagnosticsResult, type SessionReadyEvent } from "@morty-build/client/protocol";
import { MortyClient, MortyRuntimePairingRequest } from "@morty-build/client/server";
import * as v from "valibot";
import {
    PlatformProjectError,
    platformIdentifier,
    platformProjectSchema,
} from "../components/management/entity/platform-project.ts";
import type { ProjectLocationHint } from "../components/management/util/project-location.ts";
import {
    appOriginBindingSchema,
    type CloudBindings,
    platformCredentialBindingsSchema,
    platformEndpointBindingsSchema,
} from "../infra/cloud-bindings.ts";

const relayErrorSchema = v.object({ error: v.object({ code: v.string() }) });

function runtimeSetupMessage(code: string): string {
    // Keep actionable, locally owned explanations without forwarding untrusted upstream text.
    switch (code) {
        case "native_session_not_found":
            return "Morty could not complete Runtime setup. Cause: The native session was not found.";
        case "session_not_found":
            return "Morty could not complete Runtime setup. Cause: The session was not found.";
        case "local_authorization_failed":
            return "Morty could not complete Runtime setup. Cause: This directory is missing or unavailable, or the Runtime denied access to the selected session.";
        case "session_configuration_conflict":
            return "The selected Agent settings could not all be applied. Review the settings and try again.";
        default:
            return "Morty could not complete Runtime setup.";
    }
}

/** A Chat Session as the Runtime hosts it: which Runtime, Agent and directory serve it. */
type ChatSessionTarget = {
    readonly sessionId: string;
    readonly runtimeId: string;
    readonly agentRef: string;
    readonly workspaceRef: string;
};

export type NewChatSessionInput = ChatSessionTarget & {
    readonly configurations: readonly {
        readonly booleanValue: boolean;
        readonly configId: string;
        readonly value: string;
        readonly valueType: "select" | "boolean";
    }[];
};

export type ExistingChatSessionInput = ChatSessionTarget & {
    readonly additionalDirectoryIds: readonly string[];
};

const discoveredRuntimeSchema = v.object({
    agents: v.array(
        v.object({
            id: platformIdentifier,
            label: v.string(),
        }),
    ),
    machineName: v.string(),
    online: v.boolean(),
    runtimeId: platformIdentifier,
});
const runtimeLatencySchema = v.strictObject({
    latencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export class PlatformProjectGateway {
    readonly #bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.#bindings = bindings;
    }

    readonly configuration = () => {
        try {
            const bindings = v.parse(platformEndpointBindingsSchema, this.#bindings);
            const appOrigin = v.safeParse(appOriginBindingSchema, this.#bindings);
            const endpoint = new URL(bindings.MORTY_RELAY_URL);
            if (
                (endpoint.protocol !== "https:" &&
                    !(
                        endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
                    )) ||
                endpoint.username !== "" ||
                endpoint.password !== "" ||
                endpoint.pathname !== "/" ||
                endpoint.search !== "" ||
                endpoint.hash !== "" ||
                (appOrigin.success && endpoint.origin === new URL(appOrigin.output.APP_ORIGIN).origin)
            ) {
                throw new Error("Invalid Morty relay endpoint");
            }
            return { origin: endpoint.origin };
        } catch (cause) {
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Morty relay is not configured.", 503, { cause });
        }
    };

    readonly createPairing = async (projectId: string, idempotencyKey: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const pairing = await client.runtimePairings.create(new MortyRuntimePairingRequest(idempotencyKey), signal);
            if (pairing.projectId !== projectId) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Morty returned an unexpected pairing.",
                    502,
                );
            }
            return { ...pairing, relayUrl: this.configuration().origin };
        });

    readonly chatRuntimes = async (projectId: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const runtimes = await client.runtimes.list(signal);
            return runtimes.map((runtime) => ({
                runtimeId: runtime.runtimeId,
                machineName: runtime.machineName,
                online: runtime.online,
                agents: runtime.agents.map((agent) => ({ agentRef: agent.id, label: agent.label })),
            }));
        });

    readonly getChatRuntimeAgents = async (projectId: string, runtimeId: string, parent: AbortSignal) => {
        const parsedProjectId = v.parse(platformIdentifier, projectId);
        const parsedRuntimeId = v.parse(platformIdentifier, runtimeId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/projects/${encodeURIComponent(parsedProjectId)}/runtimes/${encodeURIComponent(parsedRuntimeId)}/agents`;
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                const refusal = v.safeParse(relayErrorSchema, await response.json().catch(() => null));
                if (refusal.success && refusal.output.error.code === "runtime_revoked") {
                    throw new PlatformProjectError(
                        "RUNTIME_REVOKED",
                        "This computer was disconnected because its connection key was used somewhere else. Run Morty setup on it again to reconnect.",
                        410,
                    );
                }
                throw new PlatformProjectError(
                    response.status === 404 ? "NOT_FOUND" : "PLATFORM_UNAVAILABLE",
                    "Morty could not read the Runtime's Agents.",
                    response.status === 404 ? 404 : 502,
                );
            }
            const runtime = v.parse(discoveredRuntimeSchema, await response.json());
            if (runtime.runtimeId !== parsedRuntimeId) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Morty returned Agents for an unexpected Runtime.",
                    502,
                );
            }
            return {
                runtimeId: runtime.runtimeId,
                machineName: runtime.machineName,
                online: runtime.online,
                agents: runtime.agents.map((agent) => ({ agentRef: agent.id, label: agent.label })),
            };
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Reading Runtime Agents timed out.", 504, { cause });
            }
            if (cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Morty could not read Runtime Agents.", 502, {
                cause,
            });
        }
    };

    readonly readRuntimeDiagnostics = async (projectId: string, runtimeId: string, parent: AbortSignal) => {
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/projects/${encodeURIComponent(v.parse(platformIdentifier, projectId))}/runtimes/${encodeURIComponent(v.parse(platformIdentifier, runtimeId))}/diagnostics`;
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
        try {
            const response = await fetch(endpoint, {
                signal,
                headers: {
                    authorization: `Bearer ${v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new PlatformProjectError("RUNTIME_UNAVAILABLE", "Daemon diagnostics are unavailable.", 503);
            }
            return decodeRuntimeDiagnosticsResult(await response.text());
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Daemon diagnostics timed out.", 504, { cause });
            }
            throw new PlatformProjectError("RUNTIME_UNAVAILABLE", "Daemon diagnostics are unavailable.", 503, {
                cause,
            });
        }
    };

    readonly measureRuntimeLatency = async (projectId: string, runtimeId: string, parent: AbortSignal) => {
        const parsedProjectId = v.parse(platformIdentifier, projectId);
        const parsedRuntimeId = v.parse(platformIdentifier, runtimeId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/projects/${encodeURIComponent(parsedProjectId)}/runtimes/${encodeURIComponent(parsedRuntimeId)}/latency`;
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                await response.body?.cancel();
                throw new PlatformProjectError(
                    "RUNTIME_UNAVAILABLE",
                    "The local Runtime did not respond to the network diagnostic.",
                    503,
                );
            }
            return v.parse(runtimeLatencySchema, await response.json()).latencyMs;
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "The network diagnostic timed out.", 504, {
                    cause,
                });
            }
            if (cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "The network diagnostic failed.", 502, {
                cause,
            });
        }
    };

    readonly measureRelayLatency = async (projectId: string, parent: AbortSignal): Promise<number> => {
        const parsedProjectId = v.parse(platformIdentifier, projectId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/projects/${encodeURIComponent(parsedProjectId)}/latency`;
        const startedAt = performance.now();
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                await response.body?.cancel();
                throw new PlatformProjectError(
                    "PLATFORM_UNAVAILABLE",
                    "Morty relay did not respond to the network diagnostic.",
                    502,
                );
            }
            await response.body?.cancel();
            return Math.max(0, Math.round(performance.now() - startedAt));
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "The network diagnostic timed out.", 504, {
                    cause,
                });
            }
            if (cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "The network diagnostic failed.", 502, {
                cause,
            });
        }
    };

    readonly openChatRuntimeHost = async (
        projectId: string,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<WebSocket> => {
        signal.throwIfAborted();
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/projects/${encodeURIComponent(v.parse(platformIdentifier, projectId))}/runtimes/${encodeURIComponent(v.parse(platformIdentifier, runtimeId))}/host`;
        const authorization = `Bearer ${v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`;
        const handshake = new AbortController();
        const abort = () => handshake.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => handshake.abort(new Error("Runtime connection timed out.")), 20_000);
        let response: Response;
        try {
            response = await fetch(endpoint, {
                headers: { authorization, Upgrade: "websocket" },
                signal: handshake.signal,
            });
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
        }
        if (response.status !== 101 || response.webSocket === null) {
            throw new PlatformProjectError("RUNTIME_UNAVAILABLE", "The local Runtime could not be connected.", 503);
        }
        return response.webSocket;
    };

    readonly listChatDirectory = async (
        projectId: string,
        runtimeId: string,
        directoryId: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.listWorkspace(runtimeId, directoryId, signal),
            120000,
        );

    readonly discoverChatAgentSettings = async (
        projectId: string,
        selection: { readonly runtimeId: string; readonly agentRef: string; readonly workspaceRef: string },
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const settings = await client.runtimes.discoverAgentSettings(
                    selection.runtimeId,
                    selection.agentRef,
                    { directoryId: selection.workspaceRef },
                    signal,
                );
                if (settings.agentId !== selection.agentRef || settings.directoryId !== selection.workspaceRef) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Morty returned settings for an unexpected Agent or directory.",
                        502,
                    );
                }
                return settings;
            },
            120000,
        );

    /**
     * Creates a new Session with its settings applied by the Runtime's create operation. A refusal (4xx) means the
     * Runtime created nothing; any other failure leaves it unknown whether the Session exists. Creating the same Session
     * again converges on it.
     */
    readonly createChatSession = async (projectId: string, input: NewChatSessionInput, signal: AbortSignal) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) =>
                this.#expectSession(
                    await client.sessions.create(
                        {
                            additionalDirectoryIds: [],
                            agentId: input.agentRef,
                            configurations: input.configurations,
                            directoryId: input.workspaceRef,
                            runtimeId: input.runtimeId,
                            sessionId: input.sessionId,
                        },
                        signal,
                    ),
                    input.sessionId,
                ),
            120000,
        );

    /** Grants access to a Session the Runtime has just created and reported ready. */
    readonly createdChatSessionAccess = async (
        projectId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) =>
                await this.#sessionAccess(client, projectId, session, ready, credentialLifetimeSeconds, signal),
            120000,
        );

    /** Loads an existing Session in the Runtime and grants access to it. */
    readonly openChatSession = async (
        projectId: string,
        input: ExistingChatSessionInput,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const ready = this.#expectSession(
                    await client.sessions.load(
                        input.runtimeId,
                        input.sessionId,
                        {
                            additionalDirectoryIds: input.additionalDirectoryIds,
                            agentId: input.agentRef,
                            directoryId: input.workspaceRef,
                        },
                        signal,
                    ),
                    input.sessionId,
                );
                return await this.#sessionAccess(client, projectId, input, ready, credentialLifetimeSeconds, signal);
            },
            120000,
        );

    readonly #expectSession = (ready: SessionReadyEvent, sessionId: string): SessionReadyEvent => {
        if (ready.sessionId !== sessionId) {
            throw new PlatformProjectError("PLATFORM_INVALID_RESPONSE", "Morty returned an unexpected Session.", 502);
        }
        return ready;
    };

    readonly #sessionAccess = async (
        client: MortyClient,
        projectId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) => {
        const access = await client.sessions.createAccess(
            session.runtimeId,
            session.sessionId,
            credentialLifetimeSeconds,
            signal,
        );
        return {
            endpoint: this.configuration().origin,
            projectId,
            sessionId: session.sessionId,
            credential: access.credential,
            expiresAt: access.expiresAt,
            ready,
            agentRef: session.agentRef,
            workspaceRef: session.workspaceRef,
        };
    };

    readonly queryChatSessions = async (
        projectId: string,
        runtimeId: string,
        sessionIds: readonly string[],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.querySessions(runtimeId, sessionIds, signal),
            120000,
        );

    readonly readChatSession = async (
        projectId: string,
        selection: { readonly runtimeId: string },
        sessionId: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const restored = await client.sessions.restore(selection.runtimeId, sessionId, signal);
                const session = restored.entry;
                const ready = restored.ready;
                return {
                    agentRef: session.agentId,
                    ready,
                    entry: {
                        entryId: session.sessionId,
                        mortySessionIds: [session.sessionId],
                        nativeSessionId: session.sessionId,
                        title: session.title,
                        directoryId: ready.directoryId,
                        directoryLabel: ready.directoryLabel,
                        additionalDirectories: ready.additionalDirectories,
                        updatedAt: session.updatedAt,
                    },
                };
            },
            120000,
        );

    readonly closeChatSession = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<void> =>
        await this.#withProject(projectId, signal, async (client) => {
            await client.sessions.close(runtimeId, sessionId, signal);
        });

    readonly nativeSessionAccess = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(projectId, signal, async (client) => {
            const access = await client.sessions.createAccess(runtimeId, sessionId, credentialLifetimeSeconds, signal);
            return { ...access, endpoint: this.configuration().origin };
        });

    /** Ends every Session credential issued for the Project until now, and the live views opened with them. */
    readonly revokeSessionAccess = async (projectId: string, signal: AbortSignal): Promise<void> => {
        await this.#withProject(projectId, signal, async (client) => {
            await client.sessions.revokeAccess(signal);
        });
    };

    readonly nativeSessions = async (
        projectId: string,
        runtimeId: string,
        request: Parameters<MortyClient["runtimes"]["nativeSessions"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                return await client.runtimes.nativeSessions(runtimeId, request, signal);
            },
            120000,
        );

    readonly forkNativeSession = async (
        projectId: string,
        runtimeId: string,
        operationId: string,
        input: Parameters<MortyClient["runtimes"]["forkNativeSession"]>[2],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.forkNativeSession(runtimeId, operationId, input, signal),
            120000,
        );

    readonly previewRuntimeNativeEvents = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        identity: Parameters<MortyClient["sessions"]["previewRuntimeNativeEvents"]>[2],
        page: Parameters<MortyClient["sessions"]["previewRuntimeNativeEvents"]>[3],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) =>
                await client.sessions.previewRuntimeNativeEvents(runtimeId, sessionId, identity, page, signal),
            120000,
        );

    readonly findNativeSessionByNativeSessionId = async (
        projectId: string,
        runtimeId: string,
        request: Parameters<MortyClient["runtimes"]["findNativeSessionByNativeSessionId"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.findNativeSessionByNativeSessionId(runtimeId, request, signal),
            120000,
        );

    readonly readPairing = async (projectId: string, pairingId: string, signal: AbortSignal) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimePairings.read(pairingId, signal),
        );

    readonly #withProject = async <T>(
        projectId: string,
        signal: AbortSignal,
        operation: (client: MortyClient) => Promise<T>,
        operationTimeoutMilliseconds = 15000,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MortyClient({
            endpoint: this.configuration().origin,
            projectId: v.parse(platformIdentifier, projectId),
            credentialProvider: new MortyAppCredentialProvider(
                v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET,
            ),
            operationTimeoutMilliseconds,
        });
        try {
            return await operation(client);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MortyCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MortyTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Morty relay did not respond in time.", 504, {
                    cause,
                });
            }
            if (cause instanceof MortyApiError && cause.status === 404) {
                throw new PlatformProjectError("NOT_FOUND", "The Runtime pairing was not found.", 404, { cause });
            }
            if (cause instanceof MortyError) {
                throw new PlatformProjectError(
                    cause.code,
                    runtimeSetupMessage(cause.code),
                    cause instanceof MortyApiError ? cause.status : 502,
                    { cause },
                );
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Morty could not complete Runtime setup.", 502, {
                cause,
            });
        }
    };

    readonly create = async (
        userId: string,
        displayName: string,
        signal: AbortSignal,
        requestedLocationHint?: ProjectLocationHint,
        clientReference?: string,
    ) => {
        signal.throwIfAborted();
        const configuration = this.configuration();
        const locationHint = requestedLocationHint ?? "apac";
        const reference = clientReference ?? userId;
        const client = new MortyPlatformAppClient({
            endpoint: configuration.origin,
            credentialProvider: new MortyAppCredentialProvider(
                v.parse(platformCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET,
            ),
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const project = await client.createProject(
                {
                    clientReference: reference,
                    idempotencyKey: `cloud-${reference}`,
                    displayName,
                    locationHint,
                },
                signal,
            );
            if (project.clientReference !== reference || project.lifecycle !== "active") {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Morty returned an unexpected Project.",
                    502,
                );
            }
            return v.parse(platformProjectSchema, project);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MortyCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MortyTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Morty relay did not respond in time.", 504, {
                    cause,
                });
            }
            if (cause instanceof MortyApiError && (cause.status === 401 || cause.status === 403)) {
                throw new PlatformProjectError(
                    "PLATFORM_APP_UNAUTHORIZED",
                    "The Chat App is not authorized to provision Projects.",
                    502,
                    { cause },
                );
            }
            if (cause instanceof MortyApiError && cause.status === 409) {
                throw new PlatformProjectError(
                    "PLATFORM_PROJECT_CONFLICT",
                    "Project provisioning conflicts with an earlier request.",
                    409,
                    { cause },
                );
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Morty could not provision the Project.", 502, {
                cause,
            });
        }
    };
}
