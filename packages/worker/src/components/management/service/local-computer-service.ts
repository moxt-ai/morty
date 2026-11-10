import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeAgentSettingsDiscoverCommand,
    decodeNativeSessionRequest,
    decodeNativeSessionResult,
    decodeRuntimeDiagnosticsResult,
    decodeSessionArchiveCommand,
    decodeSessionArchivedEvent,
    decodeSessionCreateCommand,
    decodeSessionListCommand,
    decodeSessionPrepareCommand,
    decodeSessionQueryCommand,
    decodeSessionReadyEvent,
    decodeSessionRestoreCommand,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceListCommand,
    type NativeEventPageRequest,
    type NativeSessionRequest,
    type NativeSessionTarget,
    type SessionReadyEvent,
} from "@morty-build/client/protocol";
import { isHttpError } from "@morty-build/relay-core";
import * as v from "valibot";
import type { ComputerBackendService } from "../../../../../relay/src/service/computer-backend-service.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { ComputerManagementError, relayIdentifier } from "../entity/computer-management.ts";

type ChatSessionTarget = {
    readonly target: NativeSessionTarget;
    readonly computerId: string;
    readonly harness: string;
    readonly workspaceRef: string;
};
export type ExistingChatSessionInput = ChatSessionTarget;
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

function runtimeSetupMessage(code: string): string {
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

/** Application use cases call the services in their own ComputerRelay, not an HTTP client or another Worker. */
export class LocalComputerService {
    readonly bindings: CloudBindings;
    readonly computer: ComputerBackendService;
    constructor(bindings: CloudBindings, computer: ComputerBackendService) {
        this.bindings = bindings;
        this.computer = computer;
    }

    readonly configuration = () => {
        const origin = v.parse(v.object({ APP_ORIGIN: v.string() }), this.bindings).APP_ORIGIN;
        const endpoint = new URL(origin);
        if (
            endpoint.origin !== origin ||
            !(
                endpoint.protocol === "https:" ||
                (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
            )
        ) {
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty origin is not configured.", 503);
        }
        return { origin };
    };

    readonly #run = async <T>(
        computerId: string,
        parent: AbortSignal,
        operation: (computer: ComputerBackendService, signal: AbortSignal) => Promise<T>,
        timeout = 120_000,
    ): Promise<T> => {
        const selected = v.parse(relayIdentifier, computerId);
        if (this.computer.computerId !== selected) {
            throw new ComputerManagementError("NOT_FOUND", "The selected computer is unavailable.", 404);
        }
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new DOMException("Runtime operation timed out", "TimeoutError")),
            timeout,
        );
        const signal = AbortSignal.any([parent, deadline.signal]);
        try {
            signal.throwIfAborted();
            return await operation(this.computer, signal);
        } catch (cause) {
            parent.throwIfAborted();
            if (deadline.signal.aborted) {
                throw new ComputerManagementError("RELAY_TIMEOUT", "Morty did not respond in time.", 504, { cause });
            }
            if (cause instanceof ComputerManagementError) {
                throw cause;
            }
            if (isHttpError(cause)) {
                const error = cause.toHttpJson();
                throw new ComputerManagementError(
                    error.body.error.code,
                    runtimeSetupMessage(error.body.error.code),
                    error.status,
                    { cause },
                );
            }
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty could not complete Runtime setup.", 502, {
                cause,
            });
        } finally {
            clearTimeout(timer);
        }
    };

    readonly createPairing = async (computerId: string, key: string, signal: AbortSignal) => ({
        ...(await this.#run(computerId, signal, (computer, signal) => computer.createPairing(key, signal), 15_000)),
        relayUrl: this.configuration().origin,
    });
    readonly readPairing = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.readPairing(signal), 15_000);
    readonly revokeRuntime = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.revokeRuntime(signal), 15_000);
    readonly chatRuntimes = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.runtimes(signal), 15_000);
    readonly getChatRuntimeAgents = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.agents(signal), 15_000);
    readonly readRuntimeDiagnostics = async (computerId: string, signal: AbortSignal) =>
        await this.#run(
            computerId,
            signal,
            async (computer, signal) =>
                decodeRuntimeDiagnosticsResult(JSON.stringify(await computer.diagnostics(signal))),
            10_000,
        );
    readonly measureRuntimeLatency = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.latency(signal), 15_000);
    readonly measureRelayLatency = async (computerId: string, signal: AbortSignal) =>
        await this.#run(
            computerId,
            signal,
            async (computer, signal) => {
                const started = performance.now();
                await computer.probe(signal);
                return Math.max(0, Math.round(performance.now() - started));
            },
            15_000,
        );
    readonly openChatRuntimeHost = async (computerId: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) => computer.openHost(signal), 20_000);
    readonly listChatDirectory = async (computerId: string, directory: string, signal: AbortSignal) =>
        await this.#run(computerId, signal, (computer, signal) =>
            computer.workspace(
                decodeWorkspaceListCommand(
                    JSON.stringify({
                        kind: "workspace.list",
                        requestId: crypto.randomUUID(),
                        directory,
                    }),
                ),
                signal,
            ),
        );
    readonly discoverChatAgentSettings = async (
        computerId: string,
        selection: { readonly computerId: string; readonly harness: string; readonly workspaceRef: string },
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, (computer, signal) =>
            computer.settings(
                decodeAgentSettingsDiscoverCommand(
                    JSON.stringify({
                        kind: "agent.settings.discover",
                        requestId: crypto.randomUUID(),
                        harness: selection.harness,
                        directory: selection.workspaceRef,
                    }),
                ),
                signal,
            ),
        );
    readonly createChatSession = async (computerId: string, input: NewChatSessionInput, signal: AbortSignal) =>
        await this.#run(computerId, signal, async (computer, signal) =>
            decodeSessionReadyEvent(
                JSON.stringify(
                    await computer.control(
                        decodeSessionCreateCommand(
                            JSON.stringify({
                                kind: "session.create",
                                requestId: crypto.randomUUID(),
                                harness: input.harness,
                                configurations: input.configurations,
                                directory: input.workspaceRef,
                                computerId: input.computerId,
                                operationId: input.operationId,
                            }),
                        ),
                        signal,
                    ),
                ),
            ),
        );
    readonly #expectSession = (ready: SessionReadyEvent, target: NativeSessionTarget) => {
        if (!sameNativeSession(ready.target, target)) {
            throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty returned an unexpected Session.", 502);
        }
        return ready;
    };
    readonly #sessionAccess = async (
        computer: ComputerBackendService,
        computerId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        lifetime: number,
        signal: AbortSignal,
    ) => ({
        ...(await computer.issueSessionAccess(session.target, lifetime, signal)),
        endpoint: this.configuration().origin,
        computerId,
        target: session.target,
        ready,
        harness: session.harness,
        workspaceRef: session.workspaceRef,
    });
    readonly createdChatSessionAccess = async (
        computerId: string,
        session: ChatSessionTarget,
        ready: SessionReadyEvent,
        lifetime: number,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, (computer, signal) =>
            this.#sessionAccess(computer, computerId, session, ready, lifetime, signal),
        );
    readonly openChatSession = async (
        computerId: string,
        input: ExistingChatSessionInput,
        lifetime: number,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) => {
            const ready = this.#expectSession(
                decodeSessionReadyEvent(
                    JSON.stringify(
                        await computer.control(
                            decodeSessionPrepareCommand(
                                JSON.stringify({
                                    kind: "session.prepare",
                                    requestId: crypto.randomUUID(),
                                    target: input.target,
                                    sessionState: "provisioned",
                                }),
                            ),
                            signal,
                        ),
                    ),
                ),
                input.target,
            );
            return await this.#sessionAccess(computer, computerId, input, ready, lifetime, signal);
        });
    readonly listChatSessions = async (computerId: string, limit: number, signal: AbortSignal) =>
        await this.#run(
            computerId,
            signal,
            async (computer, signal) =>
                decodeSessionsListedEvent(
                    JSON.stringify(
                        await computer.control(
                            decodeSessionListCommand(
                                JSON.stringify({ kind: "session.list", requestId: crypto.randomUUID(), limit }),
                            ),
                            signal,
                        ),
                    ),
                ).entries,
        );
    readonly queryChatSessions = async (
        computerId: string,
        targets: readonly NativeSessionTarget[],
        signal: AbortSignal,
    ) =>
        await this.#run(
            computerId,
            signal,
            async (computer, signal) =>
                decodeSessionsQueriedEvent(
                    JSON.stringify(
                        await computer.control(
                            decodeSessionQueryCommand(
                                JSON.stringify({ kind: "session.query", requestId: crypto.randomUUID(), targets }),
                            ),
                            signal,
                        ),
                    ),
                ).entries,
        );
    readonly readChatSession = async (
        computerId: string,
        _selection: { readonly computerId: string },
        target: NativeSessionTarget,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) => {
            const restored = decodeSessionRestoredEvent(
                JSON.stringify(
                    await computer.control(
                        decodeSessionRestoreCommand(
                            JSON.stringify({
                                kind: "session.restore",
                                requestId: crypto.randomUUID(),
                                target,
                            }),
                        ),
                        signal,
                    ),
                ),
            );
            return {
                harness: restored.entry.harness,
                ready: restored.ready,
                entry: {
                    target: restored.entry.target,
                    sessionId: restored.entry.sessionId,
                    title: restored.entry.title,
                    directory: restored.ready.directory,
                    directoryLabel: restored.ready.directoryLabel,
                    updatedAt: restored.entry.updatedAt,
                },
            };
        });
    readonly archiveChatSession = async (
        computerId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<NativeSessionTarget> =>
        await this.#run(computerId, signal, async (computer, signal) => {
            const archived = decodeSessionArchivedEvent(
                JSON.stringify(
                    await computer.control(
                        decodeSessionArchiveCommand(
                            JSON.stringify({
                                kind: "session.archive",
                                requestId: crypto.randomUUID(),
                                target,
                            }),
                        ),
                        signal,
                    ),
                ),
            );
            if (!sameNativeSession(archived.target, target)) {
                throw new ComputerManagementError("RELAY_INVALID_RESPONSE", "Morty archived a different Session.", 502);
            }
            return archived.target;
        });
    readonly nativeSessionAccess = async (
        computerId: string,
        target: NativeSessionTarget,
        lifetime: number,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) => ({
            ...(await computer.issueSessionAccess(target, lifetime, signal)),
            endpoint: this.configuration().origin,
        }));
    readonly nativeSessions = async (
        computerId: string,
        request:
            | Omit<Extract<NativeSessionRequest, { readonly action: "list" }>, "kind" | "requestId">
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "import" | "fork" }>,
                  "kind" | "requestId" | "action"
              > & { readonly action: "import" }),
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) =>
            decodeNativeSessionResult(
                JSON.stringify(
                    await computer.control(
                        decodeNativeSessionRequest(
                            JSON.stringify({
                                ...request,
                                kind: "native.session.request",
                                requestId: crypto.randomUUID(),
                            }),
                        ),
                        signal,
                    ),
                ),
            ),
        );
    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: { readonly harness: string; readonly sessionId: string; readonly directory: string },
        signal: AbortSignal,
    ) => await this.#run(computerId, signal, (computer, signal) => computer.fork(operationId, input, signal));
    readonly previewRuntimeNativeEvents = async (
        computerId: string,
        target: NativeSessionTarget,
        directory: string,
        page: NativeEventPageRequest,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, (computer, signal) =>
            computer.session(target, signal).previewEvents(directory, page),
        );
    readonly findNativeSessionBySessionId = async (
        computerId: string,
        request: Omit<Extract<NativeSessionRequest, { readonly action: "find" }>, "kind" | "requestId" | "action">,
        signal: AbortSignal,
    ) =>
        await this.#run(computerId, signal, async (computer, signal) => {
            const result = decodeNativeSessionResult(
                JSON.stringify(
                    await computer.control(
                        decodeNativeSessionRequest(
                            JSON.stringify({
                                ...request,
                                kind: "native.session.request",
                                action: "find",
                                requestId: crypto.randomUUID(),
                            }),
                        ),
                        signal,
                    ),
                ),
            );
            if (result.action !== "find") {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty returned an invalid Session lookup.",
                    502,
                );
            }
            return result;
        });
}
