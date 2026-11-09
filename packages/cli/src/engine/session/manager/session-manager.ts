import { NativeSessionMap, NativeSessionSet, nativeSessionKey } from "@morty-build/client/native-session";
import {
    isIdentifier,
    type LastTurnOutcome,
    type NativeSessionTarget,
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_CLOSED_ERROR_CODE,
    type SessionCapabilities,
    type SessionCloseNoticeEvent,
    type SessionEventPayload,
    type SessionInteractionSnapshot,
    type SessionStatus,
    type SessionStatusChangedEvent,
} from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../../infra/operation-metrics.ts";
import type { Timer } from "../../util/timer.ts";
import { AgentSession, type SessionExecutionRecord } from "../live/agent-session.ts";
import { replaySessionConfigurations, storedSessionConfiguration } from "../live/session-configurations.ts";
import { nativeSessionQuery } from "../native/native-query.ts";
import type { AgentProcessPool, AgentProcessRetention } from "../process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../process/retained-agent-processes.ts";
import {
    FoundStoredSession,
    MemorySessionStore,
    type SessionStore,
    type StoredSession,
} from "../record/session-store.ts";
import { isModelOption } from "../settings/configuration-dependencies.ts";
import { ActiveExecutions } from "../turn/active-executions.ts";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import { RuntimeOperations, waitForSharedOperation } from "./operation-drain.ts";

const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;
const SESSION_CLOSE_TIMEOUT_MILLISECONDS = 30_000;

/** What preparing does with a closed Session: a prepare or restore reopens it, a read must keep it closed. */
export type ClosedSessionHandling = "reopen" | "keep-closed";

import {
    type AgentSettingsInspectionOptions,
    AgentSettingsSnapshot,
    type ElicitationResponseOptions,
    NullSessionObserver,
    type PermissionResponseOptions,
    type PreparedSession,
    type PromptResult,
    type ResolveAgent,
    type SessionConfigurationChange,
    type SessionConfigurationSnapshot,
    type SessionConfigureOptions,
    type SessionCreationOptions,
    type SessionObserver,
    type SessionPrepareOptions,
    type SessionRecovery,
    type SessionSteerOptions,
    type SessionTurnOptions,
} from "../api/session-api.ts";
import type { SessionEventPage } from "../history/session-event-store.ts";

/** Identifies a native session while an import, fork, or continuation manages it. */
const nativeOperationKey = (harness: string, sessionId: string): string => `${harness}:${sessionId}`;

export class SessionManager {
    readonly #operations = new RuntimeOperations();
    readonly #processes: AgentProcessPool;
    readonly #executionProcesses = new RetainedAgentProcesses<AgentSession, NativeSessionTarget>(
        {
            touch: (runtime) => this.#processes.touch(runtime),
            changed: () => this.#processes.notifyChanged(),
        },
        nativeSessionKey,
    );
    readonly #executions: ActiveExecutions;
    readonly #settledTurns: (target: NativeSessionTarget) => readonly SettledTurn[];
    readonly #executionRecord: SessionExecutionRecord = {
        agentCommand: (target) => this.#executions.agentCommand(target),
        settledTurns: (target) => this.#settledTurns(target),
    };
    readonly #lastTurn: (target: NativeSessionTarget) => LastTurnOutcome | undefined;
    readonly #agentSettingsObserver = new NullSessionObserver();
    readonly #nativeOperations = new Set<string>();
    /** A creation owns initialization and failure cleanup until its whole operation settles. */
    readonly #sessionCreations = new NativeSessionSet();
    readonly #sessionClosures = new NativeSessionMap<Promise<void>>();
    readonly #sessionRetirements = new NativeSessionMap<Promise<void>>();
    /** Sessions that were closed and not reopened since. Only a prepare or restore of the Session reopens it. */
    readonly #closedSessions = new NativeSessionMap<string>();
    readonly #store: SessionStore;
    readonly #onSessionClosed: (event: SessionCloseNoticeEvent) => void;
    readonly #timer: Timer;
    #observer: SessionObserver;

    constructor({
        observer,
        store,
        processes,
        onSessionStatusChanged,
        onSessionClosed = () => undefined,
        lastTurn = () => undefined,
        settledTurns = () => [],
        timer,
    }: {
        readonly observer: SessionObserver;
        readonly store: SessionStore;
        readonly processes: AgentProcessPool;
        readonly onSessionStatusChanged: (event: SessionStatusChangedEvent) => void;
        /** Called once each time a Session becomes closed, so every client learns of it. */
        readonly onSessionClosed?: (event: SessionCloseNoticeEvent) => void;
        /** How the Session's most recent started command ended, as the execution receipts retain it. */
        readonly lastTurn?: (target: NativeSessionTarget) => LastTurnOutcome | undefined;
        /** The Session's settled turns the execution receipts retain, which a replayed history places. */
        readonly settledTurns?: (target: NativeSessionTarget) => readonly SettledTurn[];
        readonly timer: Timer;
    }) {
        this.#observer = observer;
        this.#processes = processes;
        this.#store = store;
        this.#lastTurn = lastTurn;
        this.#settledTurns = settledTurns;
        this.#executions = new ActiveExecutions((target, status) =>
            onSessionStatusChanged({
                kind: "session.status.changed",
                target,
                status: this.#reported(target, status),
            }),
        );
        this.#onSessionClosed = onSessionClosed;
        this.#timer = timer;
    }

    readonly recordLifecycleEvent = async (
        target: NativeSessionTarget,
        event: SessionEventPayload,
    ): Promise<boolean> => {
        const runtime = this.#executionProcesses.get(target);
        if (runtime === undefined) {
            return false;
        }
        return await runtime.recordControlEvent(event);
    };

    readonly setObserver = (observer: SessionObserver): void => {
        this.#observer = observer;
    };

    #isNativeSessionOperationActive(target: NativeSessionTarget): boolean {
        if (this.#nativeOperations.size === 0) {
            return false;
        }
        const stored = this.#store.read(target);
        return (
            stored instanceof FoundStoredSession &&
            this.#nativeOperations.has(nativeOperationKey(stored.session.harness, stored.session.sessionId))
        );
    }

    #retention(target: NativeSessionTarget): AgentProcessRetention<AgentSession> {
        return {
            isBusy: () =>
                this.#executionProcesses.get(target)?.hasBackgroundActivity() === true ||
                this.#executions.isBusy(target) ||
                this.#executionProcesses.isBusy(target) ||
                this.#isNativeSessionOperationActive(target),
            retire: (runtime) => this.#retireSessionProcess(target, runtime, () => runtime.close()),
            retireIdle: (runtime) => this.#stopSessionProcess(target, runtime),
        };
    }

    /**
     * Retires a Session's process. The stored Session outlives it, whatever ended the process: only an operation
     * that ends the Session itself removes its title, settings and native identity.
     */
    async #retireSessionProcess(
        target: NativeSessionTarget,
        runtime: AgentSession,
        close: () => Promise<void>,
    ): Promise<void> {
        this.#executionProcesses.detach(target, runtime);
        await this.#processes.retire(runtime, close);
    }

    /**
     * Releases a closed or idle Session's process while keeping its title, settings and native
     * identity available for the next preparation. This does not mark the Session closed.
     */
    async #stopSessionProcess(target: NativeSessionTarget, runtime: AgentSession): Promise<void> {
        this.#executionProcesses.detach(target, runtime);
        const retirement = this.#processes.retire(runtime, () => runtime.close());
        this.#sessionRetirements.set(target, retirement);
        try {
            await retirement;
        } finally {
            if (this.#sessionRetirements.get(target) === retirement) {
                this.#sessionRetirements.delete(target);
            }
        }
    }

    #isKnownSession(target: NativeSessionTarget): boolean {
        return (
            this.#executionProcesses.get(target) !== undefined ||
            this.#executionProcesses.pending(target) !== undefined ||
            this.#store.read(target) instanceof FoundStoredSession
        );
    }

    /**
     * Marks a Session closed and tells every client why, once for each closing. Clients show `reason` to their
     * users as is. Unknown Sessions have nothing to close.
     */
    #announceClosed(target: NativeSessionTarget, reason: string): void {
        if (this.#closedSessions.has(target) || !this.#isKnownSession(target)) {
            return;
        }
        this.#closedSessions.set(target, reason);
        this.#onSessionClosed({ kind: SESSION_CLOSE_NOTICE_KIND, reason, target });
    }

    /** A closed Session fails the operations that would silently reopen it, so a client learns that its view is stale. */
    #assertOpen(target: NativeSessionTarget): void {
        const reason = this.#closedSessions.get(target);
        if (reason !== undefined) {
            throw new AcpExecutionError(reason, {}, SESSION_CLOSED_ERROR_CODE);
        }
    }

    async #startRetainedSessionProcess(
        options: SessionPrepareOptions,
        start: (capabilities: SessionCapabilities) => Promise<AgentSession>,
    ): Promise<AgentSession> {
        const retiring = this.#sessionRetirements.get(options.target);
        if (retiring !== undefined) {
            // The old process may still own the native writer while graceful teardown runs.
            await waitForSharedOperation(retiring, options.signal);
        }
        const stored = this.#store.read(options.target);
        // Discovery may acquire a pooled reader: do it before reserving execution capacity.
        const capabilities =
            options.origin !== undefined || stored instanceof FoundStoredSession
                ? await options.adapter.getCapabilities(nativeSessionQuery(options))
                : unsupportedSessionCapabilities();
        const runtime = await this.#processes.startRetained(
            options.signal,
            () => start(capabilities),
            this.#retention(options.target),
        );
        this.#executionProcesses.retain(options.target, runtime);
        return runtime;
    }

    async #startPreparation(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> {
        return await this.#executionProcesses.prepare(options.target, async () => {
            const effectiveOptions = options;
            return await this.#startRetainedSessionProcess(
                effectiveOptions,
                async (capabilities) =>
                    await AgentSession.start(
                        effectiveOptions,
                        recovery,
                        () => this.#observer,
                        this.#executionRecord,
                        this.#store,
                        metrics,
                        options.adapter,
                        capabilities,
                    ),
            );
        });
    }

    async #replaceExecutionPreparation(existing: AgentSession, options: SessionPrepareOptions): Promise<AgentSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
        return await this.#executionProcesses.prepare(options.target, async () => {
            await this.#retireSessionProcess(options.target, existing, async () => await existing.close());
            const runtime = await this.#startRetainedSessionProcess(
                options,
                async (capabilities) =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#executionRecord,
                        this.#store,
                        unmeasuredOperationMetrics,
                        options.adapter,
                        capabilities,
                    ),
            );
            try {
                await replaySessionConfigurations(
                    desiredConfigOptions.map(storedSessionConfiguration),
                    () => runtime.prepared().configOptions,
                    async (desired) => {
                        await runtime.applyConfiguration({
                            ...options,
                            booleanValue: desired.type === "boolean" && desired.booleanValue,
                            configId: desired.configId,
                            requestId: `execution-prepare-${desired.configId}`,
                            value: desired.type === "select" ? desired.value : "",
                            valueType: desired.type,
                        });
                    },
                    options.signal,
                );
            } catch (error) {
                await this.#retireSessionProcess(options.target, runtime, async () => await runtime.close());
                throw error;
            }
            return runtime;
        });
    }

    /**
     * Reuses an idle process only while it still continues the latest native conversation.
     * Otherwise its Agent would answer from, and append to, an earlier copy, so the process is
     * released and the Session reopens from native history as after idle reclamation.
     */
    async #currentSessionProcess(
        existing: AgentSession,
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
    ): Promise<AgentSession> {
        const changed =
            !this.#isNativeSessionOperationActive(options.target) &&
            (await existing.nativeHistoryChanged(options.signal));
        // Another operation may have reopened the Session while the native history was read.
        const pending = this.#executionProcesses.pending(options.target);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, options.signal);
        }
        const current = this.#executionProcesses.get(options.target);
        if (current !== undefined && current !== existing) {
            return current;
        }
        if (!changed) {
            return existing;
        }
        return await this.#executionProcesses.prepare(options.target, async () => {
            await this.#stopSessionProcess(options.target, existing);
            return await this.#startRetainedSessionProcess(
                options,
                async (capabilities) =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#executionRecord,
                        this.#store,
                        unmeasuredOperationMetrics,
                        options.adapter,
                        capabilities,
                    ),
            );
        });
    }

    async #prepareSession(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        closed: ClosedSessionHandling,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> {
        return await this.#executionProcesses.use(options.target, async () =>
            this.#operations.run(options, async (options) => {
                const closing = this.#sessionClosures.get(options.target);
                if (closing !== undefined) {
                    await waitForSharedOperation(closing, options.signal);
                }
                if (closed === "reopen") {
                    // Preparing or restoring a Session is how a client reopens it.
                    this.#closedSessions.delete(options.target);
                } else {
                    this.#assertOpen(options.target);
                }
                if (
                    metrics.measureSync("session-state-read", () =>
                        this.#isNativeSessionOperationActive(options.target),
                    )
                ) {
                    throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
                }
                const pending = this.#executionProcesses.pending(options.target);
                if (pending !== undefined) {
                    const runtime = await metrics.measure(
                        "session-preparation-wait",
                        async () => await waitForSharedOperation(pending, options.signal),
                    );
                    if (runtime.runsIn(options.cwd)) {
                        this.#executionProcesses.touch(options.target, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    return await this.#prepareSession(options, recovery, closed, metrics);
                }
                const existing = this.#executionProcesses.get(options.target);
                if (existing !== undefined) {
                    if (existing.runsIn(options.cwd)) {
                        const runtime = await this.#currentSessionProcess(existing, options, recovery);
                        this.#executionProcesses.touch(options.target, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    throw new AcpExecutionError(
                        "The native Session's workspace cannot change",
                        {},
                        "session_identity_mismatch",
                    );
                }
                const runtime = await this.#startPreparation(options, recovery, metrics);
                return runtime.prepared();
            }),
        );
    }

    readonly prepareSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
        closed: ClosedSessionHandling = "reopen",
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "interactive-only" }, closed, metrics);

    /**
     * Creates a Session with the initial settings `configure` applies, and answers with the configured snapshot. A
     * Session this call created that cannot take its settings is discarded, so a refused creation leaves nothing
     * behind. A Session that already existed, such as one whose creation answer was lost, is configured again and kept.
     * Concurrent creates are busy until initialization and cleanup finish; none may acknowledge a Session another
     * creation can still discard.
     */
    readonly createSession = async (
        options: SessionPrepareOptions,
        configure: (prepared: PreparedSession, signal: AbortSignal) => Promise<void>,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
        closed: ClosedSessionHandling = "reopen",
    ): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            if (this.#sessionCreations.has(options.target)) {
                throw new AcpExecutionError(
                    "The Session is still being created; retry after it finishes",
                    {},
                    "session_busy",
                );
            }
            const created = !this.#isKnownSession(options.target);
            this.#sessionCreations.add(options.target);
            try {
                await configure(await this.prepareSession(options, metrics, closed), options.signal);
                return await this.prepareSession(options, metrics, closed);
            } catch (error) {
                if (created) {
                    await this.#discardCreatedSession(options.target);
                }
                throw error;
            } finally {
                this.#sessionCreations.delete(options.target);
            }
        });

    async #discardCreatedSession(target: NativeSessionTarget): Promise<void> {
        const runtime = this.#executionProcesses.get(target);
        try {
            if (runtime !== undefined) {
                await this.#retireSessionProcess(target, runtime, async () => await runtime.close());
            }
        } finally {
            this.#store.remove(target);
        }
    }

    readonly restoreSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
        closed: ClosedSessionHandling = "reopen",
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "history-required" }, closed, metrics);

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Morty Session.
     */
    readonly inspectAgentSettings = async (options: AgentSettingsInspectionOptions): Promise<AgentSettingsSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#processes.runTransient(
                options.signal,
                async () =>
                    await AgentSession.create(
                        options,
                        () => this.#agentSettingsObserver,
                        { agentCommand: () => undefined, settledTurns: () => [] },
                        new MemorySessionStore(),
                        unmeasuredOperationMetrics,
                    ),
                async (runtime) => {
                    const prepared = runtime.prepared();
                    const discoveredModelEffort = runtime.agentSettingsModelEffort();
                    const model = options.model;
                    const modelOption = prepared.configOptions.find(isModelOption);
                    // A Session cannot switch a model select with a single value, and the
                    // Agent already reported its settings for that current model.
                    const modelIsFixed =
                        modelOption?.type === "select" &&
                        modelOption.values.length < 2 &&
                        modelOption.currentValue === model;
                    const configOptions =
                        model === undefined || modelIsFixed
                            ? prepared.configOptions
                            : (
                                  await runtime.applyConfiguration({
                                      ...options,
                                      booleanValue: false,
                                      configId: modelOption?.id ?? "model",
                                      requestId: "agent-settings-model",
                                      target: runtime.target,
                                      value: model,
                                      valueType: "select",
                                  })
                              ).configOptions;
                    return new AgentSettingsSnapshot(
                        prepared.agentName,
                        prepared.agentVersion,
                        configOptions,
                        discoveredModelEffort === null
                            ? { kind: "unavailable" }
                            : { kind: "complete", value: discoveredModelEffort },
                    );
                },
                async (runtime) => await runtime.close(),
            );
        });

    /**
     * Retained for Agents that expose a separate persisted configuration channel.
     * Use inspectAgentSettings for Agent-scoped settings discovery.
     */
    readonly inspectSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            if (
                this.#executionProcesses.pending(options.target) !== undefined ||
                this.#executionProcesses.get(options.target) !== undefined
            ) {
                throw new AcpExecutionError(
                    "The configuration inspection session is already in use",
                    {},
                    "session_busy",
                );
            }
            return await this.#executionProcesses.use(options.target, async () => {
                const runtime = await this.#startPreparation(options, { kind: "interactive-only" }, metrics);
                try {
                    return runtime.prepared();
                } finally {
                    try {
                        await this.#retireSessionProcess(options.target, runtime, async () => await runtime.close());
                    } finally {
                        this.#store.remove(options.target);
                    }
                }
            });
        });

    readonly prepareExecutionSession = async (options: SessionPrepareOptions): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
            this.#assertOpen(options.target);
            const pending = this.#executionProcesses.pending(options.target);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
                return await this.prepareExecutionSession(options);
            }
            const existing = this.#executionProcesses.get(options.target);
            if (existing === undefined) {
                return (await this.#startPreparation(options, recovery)).prepared();
            }
            if (!existing.runsIn(options.cwd)) {
                throw new AcpExecutionError(
                    "The workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            if (existing.usesEnvironment(options.agent.environment)) {
                const runtime = await this.#currentSessionProcess(existing, options, recovery);
                this.#executionProcesses.touch(options.target, runtime);
                return runtime.prepared();
            }
            if (this.#executions.isBusy(options.target)) {
                throw new AcpExecutionError(
                    "The execution environment cannot change while a conversation turn is running",
                    {},
                    "session_busy",
                );
            }
            return (await this.#replaceExecutionPreparation(existing, options)).prepared();
        });

    /** Applies a client's edit only while the Session's configuration still has the revision the client read. */
    readonly configureSession = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.target, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.configure(options);
            });
        });

    /** Applies a setting the Runtime owns, such as one a prompt or a preparation requested. */
    readonly applySessionConfiguration = async (
        change: SessionConfigurationChange,
    ): Promise<SessionConfigurationSnapshot> =>
        this.#operations.run(change, async (change) => {
            return await this.#executionProcesses.use(change.target, async () => {
                const runtime = await this.ensureSession(change);
                return await runtime.applyConfiguration(change);
            });
        });

    readonly renameSession = async (
        options: SessionPrepareOptions,
        title: string,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> =>
        await this.#executionProcesses.use(options.target, async () =>
            this.#operations.run(options, async (options) => {
                this.#assertOpen(options.target);
                // Process reclamation must not turn a native rename into a metadata-only write.
                // Keep the same process borrowed through recovery and the acknowledged rename.
                const existing = this.#executionProcesses.get(options.target);
                if (existing === undefined) {
                    await this.#prepareSession(options, { kind: "interactive-only" }, "keep-closed");
                } else {
                    await this.#currentSessionProcess(existing, options, { kind: "interactive-only" });
                }
                const runtime = this.#executionProcesses.get(options.target);
                if (runtime === undefined) {
                    throw new AcpExecutionError("ACP session did not start");
                }
                return await runtime.renameSession(title, options.signal);
            }),
        );

    /** Cancels the named command's Agent execution; a command that is not executing has nothing to stop. */
    readonly cancelPrompt = async (
        target: NativeSessionTarget,
        commandId: string,
        signal: AbortSignal = AbortSignal.timeout(30_000),
    ): Promise<void> =>
        this.#operations.run({ signal }, async ({ signal }) => {
            await this.#executions.cancel(target, commandId, async () => {
                const runtime = this.#executionProcesses.get(target);
                if (runtime !== undefined) {
                    const outcome = await runtime.cancel(signal);
                    switch (outcome) {
                        case "retained":
                            break;
                        case "closed":
                            // Preserve the native conversation and effective settings for
                            // the next prompt, but never reuse a cancelled endpoint.
                            await this.#stopSessionProcess(target, runtime);
                            break;
                        default: {
                            const unreachable: never = outcome;
                            throw new AcpExecutionError("Unexpected cancellation outcome", { cause: unreachable });
                        }
                    }
                }
            });
        });

    /** Whether a steering prompt can join the named execution: the one rule every steering check asks. */
    readonly acceptsSteering = (target: NativeSessionTarget, targetCommandId: string): boolean =>
        this.#executions.acceptsSteering(target, targetCommandId);

    readonly steerPrompt = async (options: SessionSteerOptions): Promise<string> =>
        this.#operations.run(options, async (options) => {
            if (!this.acceptsSteering(options.target, options.targetCommandId)) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const pending = this.#executionProcesses.pending(options.target);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
            }
            // Nothing below awaits before the Agent receives the steer, so this check holds at the handoff.
            if (!this.acceptsSteering(options.target, options.targetCommandId)) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const runtime = this.#executionProcesses.get(options.target);
            if (runtime === undefined || !runtime.runsIn(options.cwd)) {
                throw new AcpExecutionError(
                    "The target turn execution context is unavailable",
                    {},
                    "steering_target_unavailable",
                );
            }
            const deadlineController = new AbortController();
            const deadline = setTimeout(
                () =>
                    deadlineController.abort(
                        new AcpExecutionError("The steering request exceeded its deadline", {}, "steering_timeout"),
                    ),
                SESSION_CONTROL_TIMEOUT_MILLISECONDS,
            );
            deadline.unref();
            try {
                return await runtime.steer({
                    ...options,
                    signal: AbortSignal.any([options.signal, deadlineController.signal]),
                });
            } catch (error) {
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent steering failed", { cause: error }, "steering_failed");
            } finally {
                clearTimeout(deadline);
            }
        });

    readonly runPrompt = async (options: SessionTurnOptions): Promise<PromptResult> =>
        this.#operations.run(options, async (options) => {
            // A close can land after the prompt was prepared; fail before the Session is reported working.
            this.#assertOpen(options.target);
            if (this.#isNativeSessionOperationActive(options.target)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            this.#executions.begin(options.target, options.commandId);
            // The command's own turn records a cancellation that arrives before its execution begins.
            const cancelled = (): boolean =>
                options.cancellationRequested?.() === true ||
                this.#executions.cancellationRequested(options.target, options.commandId);
            try {
                if (cancelled()) {
                    return { stopReason: "cancelled" };
                }
                const runtime = await this.ensureSession(options);
                if (this.#nativeOperations.has(nativeOperationKey(options.agent.harness, runtime.sessionId()))) {
                    throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
                }
                if (cancelled()) {
                    return { stopReason: "cancelled" };
                }
                try {
                    await runtime.preparePrompt(options.signal);
                    // Nothing awaits between this check and the Agent receiving the prompt.
                    if (cancelled()) {
                        return { stopReason: "cancelled" };
                    }
                    this.#executions.start(options.target, options.commandId);
                    const result = await runtime.prompt({
                        ...options,
                        cancellationRequested: cancelled,
                    });
                    return cancelled() ? { stopReason: "cancelled" } : result;
                } catch (error) {
                    if (cancelled()) {
                        await this.#executions.cancellation(options.target);
                        return { stopReason: "cancelled" };
                    }
                    throw error;
                } finally {
                    this.#executions.settle(options.target, options.commandId);
                }
            } catch (error) {
                const failedRuntime = this.#executionProcesses.get(options.target);
                if (failedRuntime !== undefined) {
                    await this.#retireSessionProcess(
                        options.target,
                        failedRuntime,
                        async () => await failedRuntime.close(),
                    );
                }
                if (cancelled()) {
                    return { stopReason: "cancelled" };
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent execution failed", {
                    cause: error,
                });
            } finally {
                try {
                    await this.#executions.cancellation(options.target);
                } finally {
                    this.#executions.finish(options.target, options.commandId);
                    this.#executionProcesses.touch(options.target);
                    this.#processes.notifyChanged();
                }
            }
        });

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        this.#assertOpen(options.target);
        const runtime = this.#executionProcesses.get(options.target);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        this.#assertOpen(options.target);
        const runtime = this.#executionProcesses.get(options.target);
        if (runtime === undefined) {
            throw new AcpExecutionError("The elicitation request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondElicitation(options);
    };

    readonly closeSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> =>
        this.#operations.run({ target, signal }, async (options) => {
            const existing = this.#sessionClosures.get(options.target);
            if (existing !== undefined) {
                await waitForSharedOperation(existing, options.signal);
                return;
            }
            // Announce first: clients must learn of the closing while its process is still going down.
            this.#announceClosed(options.target, "This Session was closed on request.");
            const release = (async (): Promise<void> => {
                try {
                    const execution = this.#executions.status(options.target);
                    if (execution.kind === "working") {
                        // Closing deliberately stops this turn. Record that intent through the cancellation owner
                        // before releasing the Agent, so its teardown cannot become a retained turn failure.
                        await this.cancelPrompt(options.target, execution.commandId);
                    }
                } finally {
                    // A failed Agent cancellation must still release the closed Session's resources.
                    const retiring = this.#sessionRetirements.get(options.target);
                    if (retiring !== undefined) {
                        await retiring;
                    }
                    const pending = this.#executionProcesses.pending(options.target);
                    const runtime =
                        pending === undefined ? this.#executionProcesses.get(options.target) : await pending;
                    if (runtime !== undefined) {
                        await this.#stopSessionProcess(options.target, runtime);
                    }
                }
            })();
            const deadline = Promise.withResolvers<void>();
            const timeout = this.#timer.schedule(
                () =>
                    deadline.reject(
                        new AcpExecutionError(
                            "The Session could not close before its deadline",
                            {},
                            "session_close_timeout",
                        ),
                    ),
                SESSION_CLOSE_TIMEOUT_MILLISECONDS,
            );
            const completion = Promise.race([release, deadline.promise]).finally(timeout.cancel);
            this.#sessionClosures.set(options.target, completion);
            const releaseFinished = (): void => {
                if (this.#sessionClosures.get(options.target) === completion) {
                    this.#sessionClosures.delete(options.target);
                }
            };
            void release.then(releaseFinished, releaseFinished);
            await waitForSharedOperation(completion, options.signal);
        });

    readonly close = async (): Promise<void> => {
        const retiring = this.#processes.stopIdleReclamation();
        await this.#operations.close(async () => {
            await retiring;
            const sessions = [...this.#executionProcesses.entries()];
            await Promise.all([
                ...sessions.map(
                    async ([target, runtime]) =>
                        await this.#retireSessionProcess(target, runtime, async () => await runtime.close()),
                ),
                ...this.#sessionClosures.values(),
            ]);
        });
    };

    readonly findSessions = (targets: readonly NativeSessionTarget[]) =>
        targets.flatMap((target) => {
            const stored = this.#store.read(target);
            return stored instanceof FoundStoredSession ? [stored.session] : [];
        });

    /** The Session this Runtime holds for `target`, which a command naming only the target uses; none is refused. */
    readonly heldSession = (target: NativeSessionTarget): StoredSession => {
        const stored = this.#store.read(target);
        if (!(stored instanceof FoundStoredSession)) {
            throw new AcpExecutionError("The Session was not found", {}, "session_not_found");
        }
        return stored.session;
    };

    readonly sessionStatus = (target: NativeSessionTarget): SessionStatus =>
        this.#reported(target, this.#executions.status(target));

    /** An idle Session whose last started command failed says so, so a client that did not watch it still knows. */
    readonly #reported = (target: NativeSessionTarget, status: SessionStatus): SessionStatus => {
        if (status.kind !== "idle") {
            return status;
        }
        const lastTurn = this.#lastTurn(target);
        return lastTurn?.state === "failed"
            ? {
                  ...status,
                  failedTurn: { code: lastTurn.code, commandId: lastTurn.commandId, message: lastTurn.message },
              }
            : status;
    };

    readonly listSessions = (limit: number) =>
        this.#store
            .list()
            .filter((session) => session.prompted)
            .slice(0, limit);

    /** The actionable requests of the Session this Runtime holds for `target`; a target it does not hold is refused. */
    readonly interactionSnapshot = (target: NativeSessionTarget): SessionInteractionSnapshot => {
        const session = this.heldSession(target);
        const runtime = this.#executionProcesses.get(session.target);
        if (runtime !== undefined) {
            return runtime.interactionSnapshot();
        }
        // No live Agent owns an actionable request after its session process has gone away.
        const { sessionGenerationId, throughPosition } = this.#store.events.livePosition(session.target);
        return { sessionGenerationId, throughPosition, interactions: [] };
    };

    readonly hasPreparedSession = (target: NativeSessionTarget, cwd: string): boolean =>
        this.#executionProcesses.get(target)?.runsIn(cwd) === true;

    readonly createNativeSession = async (options: SessionCreationOptions): Promise<NativeSessionTarget> =>
        this.#operations.run(options, async (options) => {
            const runtime = await this.#processes.startUnretained(
                options.signal,
                async () =>
                    await AgentSession.create(
                        options,
                        () => this.#observer,
                        this.#executionRecord,
                        this.#store,
                        unmeasuredOperationMetrics,
                    ),
            );
            let retained = false;
            try {
                const target = runtime.target;
                if (!isIdentifier(target.sessionId) || this.#executionProcesses.get(target) !== undefined) {
                    throw new AcpExecutionError(
                        "The Agent returned an invalid new Session ID",
                        {},
                        "invalid_native_session_response",
                    );
                }
                this.#executionProcesses.retain(target, runtime);
                this.#processes.retain(runtime, this.#retention(target));
                retained = true;
                return target;
            } finally {
                if (!retained) {
                    await this.#processes.retire(runtime, () => runtime.closeProcess());
                }
            }
        });

    readonly ensureSession = async (options: SessionPrepareOptions): Promise<AgentSession> =>
        this.#operations.run(options, async (options) => {
            this.#assertOpen(options.target);
            const existing = this.#executionProcesses.get(options.target);
            if (existing !== undefined) {
                if (!existing.runsIn(options.cwd)) {
                    throw new AcpExecutionError(
                        "The workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                const runtime = await this.#currentSessionProcess(
                    existing,
                    options,
                    options.recovery ?? { kind: "interactive-only" },
                );
                this.#executionProcesses.touch(options.target, runtime);
                return runtime;
            }
            await this.#prepareSession(options, options.recovery ?? { kind: "interactive-only" }, "reopen");
            const started = this.#executionProcesses.get(options.target);
            if (started === undefined) {
                throw new AcpExecutionError("ACP session did not start");
            }
            return started;
        });

    /** Coordinates native-reader conflicts without owning the harness query. */
    readonly withNativeSessionOperation = async <Result>(
        options: SessionCreationOptions,
        sessionId: string,
        operation: (options: SessionCreationOptions) => Promise<Result>,
    ): Promise<Result> =>
        this.#operations.run(options, async (options) => {
            const key = nativeOperationKey(options.agent.harness, sessionId);
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            this.#processes.notifyChanged();
            try {
                return await operation(options);
            } finally {
                this.#nativeOperations.delete(key);
                this.#processes.notifyChanged();
            }
        });

    readonly loadSessionEvents = async (
        options: SessionPrepareOptions,
        eventLimit: number,
        cursor: string | null,
    ): Promise<SessionEventPage> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.target, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.loadHistoryEvents(eventLimit, cursor, options.signal);
            });
        });

    async #nativeTargetOptions(
        options: SessionCreationOptions,
        target: NativeSessionTarget,
        resolveAgent: ResolveAgent,
    ): Promise<SessionPrepareOptions> {
        const resolved = await resolveAgent(options.agent.harness, options.signal, target);
        options.signal.throwIfAborted();
        return { ...options, ...resolved, target };
    }

    readonly openNativeSession = async (
        options: SessionCreationOptions,
        origin: NativeSessionOrigin,
        resolveAgent: ResolveAgent,
    ): Promise<{
        readonly target: NativeSessionTarget;
        readonly prepared: PreparedSession;
    }> =>
        this.#operations.run(options, async (options) => {
            const key = nativeOperationKey(options.agent.harness, origin.sessionId);
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            const stored = this.#store.read({ harness: options.agent.harness, sessionId: origin.sessionId });
            const existing = stored instanceof FoundStoredSession ? stored.session : undefined;
            if (origin.kind === "import" && existing !== undefined) {
                return await this.#executionProcesses.use(existing.target, async () => {
                    // Importing a Session the Runtime already tracks opens it again, even when it was closed. A running
                    // turn does not prevent that: another device joins the same Session and sees the turn's progress.
                    this.#closedSessions.delete(existing.target);
                    const target = await this.#nativeTargetOptions(options, existing.target, resolveAgent);
                    const runtime = await this.ensureSession(target);
                    if (this.#nativeOperations.has(key)) {
                        throw new AcpExecutionError(
                            "Wait for the native session's running operation to finish",
                            {},
                            "session_busy",
                        );
                    }
                    this.#nativeOperations.add(key);
                    try {
                        return {
                            prepared: runtime.prepared(),
                            target: existing.target,
                        };
                    } finally {
                        this.#nativeOperations.delete(key);
                        this.#processes.notifyChanged();
                    }
                });
            }
            // A fork or a first import reads the native session, which a running turn may still be writing.
            if (
                existing !== undefined &&
                (this.#executions.isBusy(existing.target) ||
                    this.#executionProcesses.pending(existing.target) !== undefined)
            ) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            try {
                if (origin.kind === "import") {
                    const target = { harness: options.agent.harness, sessionId: origin.sessionId };
                    const preparation = await this.#nativeTargetOptions(options, target, resolveAgent);
                    const runtime = await this.#startPreparation(
                        { ...preparation, origin },
                        { kind: "interactive-only" },
                    );
                    return { target, prepared: runtime.prepared() };
                }
                const capabilities = await options.adapter.getCapabilities(nativeSessionQuery(options));
                const runtime = await this.#processes.startUnretained(
                    options.signal,
                    async () =>
                        await AgentSession.fork(
                            options,
                            origin,
                            capabilities,
                            () => this.#observer,
                            this.#executionRecord,
                            this.#store,
                            unmeasuredOperationMetrics,
                        ),
                );
                let retained = false;
                try {
                    const target = runtime.target;
                    if (this.#executionProcesses.get(target) !== undefined) {
                        throw new AcpExecutionError(
                            "The harness returned an existing fork",
                            {},
                            "invalid_native_session_response",
                        );
                    }
                    this.#executionProcesses.retain(target, runtime);
                    this.#processes.retain(runtime, this.#retention(target));
                    retained = true;
                    return { target, prepared: runtime.prepared() };
                } finally {
                    if (!retained) {
                        await this.#processes.retire(runtime, () => runtime.closeProcess());
                    }
                }
            } finally {
                this.#nativeOperations.delete(key);
                this.#processes.notifyChanged();
            }
        });
}
