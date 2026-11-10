import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeRuntimeDiagnosticsResult,
    type NativeSessionTarget,
    type SessionReadyEvent,
} from "@morty-build/client/protocol";
import {
    MortyApiError,
    MortyAppCredentialProvider,
    MortyCancellationError,
    MortyError,
    MortyRelayAppClient,
    MortyTimeoutError,
} from "@morty-build/client/relay";
import { MortyClient, MortyRuntimePairingRequest } from "@morty-build/client/server";
import * as v from "valibot";
import {
    ComputerManagementError,
    computerManagementSchema,
    relayIdentifier,
} from "../components/management/entity/computer-management.ts";
import type { ProjectLocationHint } from "../components/management/util/project-location.ts";
import {
    appOriginBindingSchema,
    type CloudBindings,
    relayCredentialBindingsSchema,
    relayEndpointBindingsSchema,
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
        case "session_close_timeout":
            return "The agent did not stop in time, so the session is still open. Try again.";
        default:
            return "Morty could not complete Runtime setup.";
    }
}

/** A Chat Session as the Runtime hosts it: which Runtime, Agent and directory serve it. */
type ChatSessionTarget = {
    readonly target: NativeSessionTarget;
    readonly computerId: string;
    readonly harness: string;
    readonly workspaceRef: string;
};

export type NewChatSessionInput = {
    readonly computerId: string;
    readonly harness: string;
    readonly workspaceRef: string;
    readonly operationId: string;
    readonly configurations: readonly {
        readonly booleanValue: boolean;
        readonly configId: string;
        readonly value: string;
        readonly valueType: "select" | "boolean";
    }[];
};

export type ExistingChatSessionInput = ChatSessionTarget;

const discoveredRuntimeSchema = v.object({
    agents: v.array(
        v.object({
            harness: relayIdentifier,
            label: v.string(),
        }),
    ),
    machineName: v.string(),
    online: v.boolean(),
    computerId: relayIdentifier,
});
const runtimeLatencySchema = v.strictObject({
    latencyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export class ComputerManagementGateway {
    readonly #bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.#bindings = bindings;
    }

    readonly configuration = () => {
        try {
            const bindings = v.parse(relayEndpointBindingsSchema, this.#bindings);
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
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty relay is not configured.", 503, { cause });
        }
    };

    readonly createPairing = async (computerId: string, idempotencyKey: string, signal: AbortSignal) =>
        await this.#withProject(computerId, signal, async (client) => {
            const pairing = await client.runtimePairings.create(new MortyRuntimePairingRequest(idempotencyKey), signal);
            if (pairing.computerId !== computerId) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty returned an unexpected pairing.",
                    502,
                );
            }
            return { ...pairing, relayUrl: this.configuration().origin };
        });

    readonly chatRuntimes = async (computerId: string, signal: AbortSignal) =>
        await this.#withProject(computerId, signal, async (client) => {
            const runtimes = await client.runtimes.list(signal);
            return runtimes.map((runtime) => ({
                computerId: runtime.computerId,
                machineName: runtime.machineName,
                online: runtime.online,
                agents: runtime.agents.map((agent) => ({ harness: agent.harness, label: agent.label })),
            }));
        });

    readonly getChatRuntimeAgents = async (computerId: string, parent: AbortSignal) => {
        const parsedComputerId = v.parse(relayIdentifier, computerId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(parsedComputerId)}/daemon/agents`;
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                const refusal = v.safeParse(relayErrorSchema, await response.json().catch(() => null));
                if (refusal.success && refusal.output.error.code === "runtime_revoked") {
                    throw new ComputerManagementError(
                        "RUNTIME_REVOKED",
                        "This computer was disconnected because its connection key was used somewhere else. Run Morty setup on it again to reconnect.",
                        410,
                    );
                }
                throw new ComputerManagementError(
                    response.status === 404 ? "NOT_FOUND" : "RELAY_UNAVAILABLE",
                    "Morty could not read the Runtime's Agents.",
                    response.status === 404 ? 404 : 502,
                );
            }
            const runtime = v.parse(discoveredRuntimeSchema, await response.json());
            if (runtime.computerId !== parsedComputerId) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty returned Agents for an unexpected Runtime.",
                    502,
                );
            }
            return {
                computerId: runtime.computerId,
                machineName: runtime.machineName,
                online: runtime.online,
                agents: runtime.agents.map((agent) => ({ harness: agent.harness, label: agent.label })),
            };
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Reading Runtime Agents timed out.", 504, { cause });
            }
            if (cause instanceof ComputerManagementError) {
                throw cause;
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty could not read Runtime Agents.", 502, {
                cause,
            });
        }
    };

    readonly readRuntimeDiagnostics = async (computerId: string, parent: AbortSignal) => {
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(v.parse(relayIdentifier, computerId))}/daemon/diagnostics`;
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
        try {
            const response = await fetch(endpoint, {
                signal,
                headers: {
                    authorization: `Bearer ${v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new ComputerManagementError("RUNTIME_UNAVAILABLE", "Daemon diagnostics are unavailable.", 503);
            }
            return decodeRuntimeDiagnosticsResult(await response.text());
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Daemon diagnostics timed out.", 504, { cause });
            }
            throw new ComputerManagementError("RUNTIME_UNAVAILABLE", "Daemon diagnostics are unavailable.", 503, {
                cause,
            });
        }
    };

    readonly measureRuntimeLatency = async (computerId: string, parent: AbortSignal) => {
        const parsedComputerId = v.parse(relayIdentifier, computerId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(parsedComputerId)}/daemon/latency`;
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                await response.body?.cancel();
                throw new ComputerManagementError(
                    "RUNTIME_UNAVAILABLE",
                    "The local Runtime did not respond to the network diagnostic.",
                    503,
                );
            }
            return v.parse(runtimeLatencySchema, await response.json()).latencyMs;
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "The network diagnostic timed out.", 504, {
                    cause,
                });
            }
            if (cause instanceof ComputerManagementError) {
                throw cause;
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "The network diagnostic failed.", 502, {
                cause,
            });
        }
    };

    readonly measureRelayLatency = async (computerId: string, parent: AbortSignal): Promise<number> => {
        const parsedComputerId = v.parse(relayIdentifier, computerId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(parsedComputerId)}/latency`;
        const startedAt = performance.now();
        try {
            const response = await fetch(endpoint, {
                headers: {
                    authorization: `Bearer ${v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`,
                },
                signal,
            });
            signal.throwIfAborted();
            if (!response.ok) {
                await response.body?.cancel();
                throw new ComputerManagementError(
                    "RELAY_UNAVAILABLE",
                    "Morty relay did not respond to the network diagnostic.",
                    502,
                );
            }
            await response.body?.cancel();
            return Math.max(0, Math.round(performance.now() - startedAt));
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "The network diagnostic timed out.", 504, {
                    cause,
                });
            }
            if (cause instanceof ComputerManagementError) {
                throw cause;
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "The network diagnostic failed.", 502, {
                cause,
            });
        }
    };

    readonly openChatRuntimeHost = async (computerId: string, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/morty/api/v1/computers/${encodeURIComponent(v.parse(relayIdentifier, computerId))}/daemon/host`;
        const authorization = `Bearer ${v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET}`;
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
            throw new ComputerManagementError("RUNTIME_UNAVAILABLE", "The local Runtime could not be connected.", 503);
        }
        return response.webSocket;
    };

    readonly listChatDirectory = async (computerId: string, directory: string, signal: AbortSignal) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.runtimes.listWorkspace(directory, signal),
            120000,
        );

    readonly discoverChatAgentSettings = async (
        computerId: string,
        selection: { readonly computerId: string; readonly harness: string; readonly workspaceRef: string },
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                const settings = await client.runtimes.discoverAgentSettings(
                    selection.harness,
                    { directory: selection.workspaceRef },
                    signal,
                );
                if (settings.harness !== selection.harness || settings.directory !== selection.workspaceRef) {
                    throw new ComputerManagementError(
                        "RELAY_INVALID_RESPONSE",
                        "Morty returned settings for an unexpected Agent or directory.",
                        502,
                    );
                }
                return settings;
            },
            120000,
        );

    /** Creates a harness-owned Session with its settings applied; retries retain the same operation identity. */
    readonly createChatSession = async (computerId: string, input: NewChatSessionInput, signal: AbortSignal) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                const ready = await client.sessions.create(
                    {
                        harness: input.harness,
                        configurations: input.configurations,
                        directory: input.workspaceRef,
                        computerId: input.computerId,
                        operationId: input.operationId,
                    },
                    signal,
                );
                if (ready.harness !== input.harness || ready.directory !== input.workspaceRef) {
                    throw new ComputerManagementError(
                        "RELAY_INVALID_RESPONSE",
                        "Morty returned an unexpected Session binding.",
                        502,
                    );
                }
                return ready;
            },
            120000,
        );

    /** Grants access to a Session the Runtime has just created and reported ready. */
    readonly createdChatSessionAccess = async (
        computerId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) =>
                await this.#sessionAccess(client, computerId, session, ready, credentialLifetimeSeconds, signal),
            120000,
        );

    /** Loads an existing Session in the Runtime and grants access to it. */
    readonly openChatSession = async (
        computerId: string,
        input: ExistingChatSessionInput,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                const ready = this.#expectSession(await client.sessions.load(input.target, signal), input.target);
                return await this.#sessionAccess(client, computerId, input, ready, credentialLifetimeSeconds, signal);
            },
            120000,
        );

    readonly #expectSession = (ready: SessionReadyEvent, target: NativeSessionTarget): SessionReadyEvent => {
        if (!sameNativeSession(ready.target, target)) {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned an unexpected Session.", 502);
        }
        return ready;
    };

    readonly #sessionAccess = async (
        client: MortyClient,
        computerId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) => {
        const access = await client.sessions.createAccess(session.target, credentialLifetimeSeconds, signal);
        return {
            endpoint: this.configuration().origin,
            computerId,
            target: session.target,
            credential: access.credential,
            expiresAt: access.expiresAt,
            ready,
            harness: session.harness,
            workspaceRef: session.workspaceRef,
        };
    };

    /** The Sessions the Runtime holds, most recently updated first. */
    readonly listChatSessions = async (computerId: string, limit: number, signal: AbortSignal) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.runtimes.listSessions(limit, signal),
            120000,
        );

    readonly queryChatSessions = async (
        computerId: string,
        targets: readonly NativeSessionTarget[],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.runtimes.querySessions(targets, signal),
            120000,
        );

    readonly readChatSession = async (
        computerId: string,
        _selection: { readonly computerId: string },
        target: NativeSessionTarget,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                const restored = await client.sessions.restore(target, signal);
                const session = restored.entry;
                const ready = restored.ready;
                return {
                    harness: session.harness,
                    ready,
                    entry: {
                        target: session.target,
                        sessionId: session.sessionId,
                        title: session.title,
                        directory: ready.directory,
                        directoryLabel: ready.directoryLabel,
                        updatedAt: session.updatedAt,
                    },
                };
            },
            120000,
        );

    /** Archives a Session on the Runtime and answers with the Session the Runtime no longer holds. */
    readonly archiveChatSession = async (
        computerId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<NativeSessionTarget> =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                const archived = await client.sessions.archive(target, signal);
                if (!sameNativeSession(archived.target, target)) {
                    throw new ComputerManagementError(
                        "RELAY_INVALID_RESPONSE",
                        "Morty archived a different Session.",
                        502,
                    );
                }
                return archived.target;
            },
            120000,
        );

    readonly nativeSessionAccess = async (
        computerId: string,
        target: NativeSessionTarget,
        credentialLifetimeSeconds: number,
        signal: AbortSignal,
    ) =>
        await this.#withProject(computerId, signal, async (client) => {
            const access = await client.sessions.createAccess(target, credentialLifetimeSeconds, signal);
            return { ...access, endpoint: this.configuration().origin };
        });

    readonly nativeSessions = async (
        computerId: string,
        request: Parameters<MortyClient["runtimes"]["nativeSessions"]>[0],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => {
                return await client.runtimes.nativeSessions(request, signal);
            },
            120000,
        );

    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: Parameters<MortyClient["runtimes"]["forkNativeSession"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.runtimes.forkNativeSession(operationId, input, signal),
            120000,
        );

    readonly previewRuntimeNativeEvents = async (
        computerId: string,
        target: NativeSessionTarget,
        directory: string,
        page: Parameters<MortyClient["sessions"]["previewRuntimeNativeEvents"]>[2],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.sessions.previewRuntimeNativeEvents(target, directory, page, signal),
            120000,
        );

    readonly findNativeSessionBySessionId = async (
        computerId: string,
        request: Parameters<MortyClient["runtimes"]["findNativeSessionBySessionId"]>[0],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            computerId,
            signal,
            async (client) => await client.runtimes.findNativeSessionBySessionId(request, signal),
            120000,
        );

    readonly readPairing = async (computerId: string, signal: AbortSignal) =>
        await this.#withProject(computerId, signal, async (client) => await client.runtimePairings.read(signal));

    readonly #withProject = async <T>(
        computerId: string,
        signal: AbortSignal,
        operation: (client: MortyClient) => Promise<T>,
        operationTimeoutMilliseconds = 15000,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MortyClient({
            endpoint: this.configuration().origin,
            computerId: v.parse(relayIdentifier, computerId),
            credentialProvider: new MortyAppCredentialProvider(
                v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET,
            ),
            operationTimeoutMilliseconds,
        });
        try {
            return await operation(client);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MortyCancellationError || cause instanceof ComputerManagementError) {
                throw cause;
            }
            if (cause instanceof MortyTimeoutError) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Morty relay did not respond in time.", 504, {
                    cause,
                });
            }
            if (cause instanceof MortyApiError && cause.status === 404) {
                throw new ComputerManagementError("NOT_FOUND", "The Runtime pairing was not found.", 404, { cause });
            }
            if (cause instanceof MortyError) {
                throw new ComputerManagementError(
                    cause.code,
                    runtimeSetupMessage(cause.code),
                    cause instanceof MortyApiError ? cause.status : 502,
                    { cause },
                );
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty could not complete Runtime setup.", 502, {
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
        const client = new MortyRelayAppClient({
            endpoint: configuration.origin,
            credentialProvider: new MortyAppCredentialProvider(
                v.parse(relayCredentialBindingsSchema, this.#bindings).MORTY_SERVICE_SECRET,
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
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty returned an unexpected Project.",
                    502,
                );
            }
            return v.parse(computerManagementSchema, project);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MortyCancellationError || cause instanceof ComputerManagementError) {
                throw cause;
            }
            if (cause instanceof MortyTimeoutError) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Morty relay did not respond in time.", 504, {
                    cause,
                });
            }
            if (cause instanceof MortyApiError && (cause.status === 401 || cause.status === 403)) {
                throw new ComputerManagementError(
                    "RELAY_APP_UNAUTHORIZED",
                    "The Chat App is not authorized to provision Projects.",
                    502,
                    { cause },
                );
            }
            if (cause instanceof MortyApiError && cause.status === 409) {
                throw new ComputerManagementError(
                    "COMPUTER_MANAGEMENT_CONFLICT",
                    "Project provisioning conflicts with an earlier request.",
                    409,
                    { cause },
                );
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty could not provision the Project.", 502, {
                cause,
            });
        }
    };
}
