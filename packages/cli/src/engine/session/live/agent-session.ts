import { conversationTitleFromText } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    type AgentModelEffort,
    isIdentifier,
    type NativeSessionTarget,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_INFO_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
    type SessionEventPayload,
    type SessionInteractionSnapshot,
} from "@morty-build/client/protocol";
import { AcpExecutionError, AcpPromptExecutionError } from "../../acp/acp-error.ts";
import { RetryableAcpInitializationError, validateAgentRuntime } from "../../acp/adapter/agent-initialization.ts";
import type { AdapterSessionEvent, AdapterSessionSubscriber } from "../../acp/adapter/session-events.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import { validatePromptContent } from "../../acp/client/prompt-content.ts";
import type {
    Adapter,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionScope,
    AdapterSessionTarget,
    NativeHistoryRevision,
} from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import type { SessionConfigurationSelection } from "../../acp/protocol/session-config-protocol.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import { SerialTaskQueue } from "../../util/serial-task-queue.ts";
import { recordsEqual, truncate } from "../../util/value-utils.ts";
import {
    type ElicitationResponseOptions,
    type PermissionResponseOptions,
    PreparedSession,
    type PromptResult,
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
import { HistoryReplayCapture } from "../history/session-history.ts";
import { SessionInteractions } from "../interaction/session-interactions.ts";
import { waitForSharedOperation } from "../manager/operation-drain.ts";
import { FoundStoredSession, MissingStoredSession, type SessionStore, StoredSession } from "../record/session-store.ts";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import type { AgentSessionRestore } from "./agent-session-restore.ts";
import { configurationRevision } from "./configuration-revision.ts";
import { SessionConfigurations } from "./session-configurations.ts";
import { restoreSession } from "./session-restore.ts";

/** Attributes Agent requests that arrive while the Agent holds no prompt of this Session. */
const SESSION_CONTROL_COMMAND_ID = "session-control";

/** What the Session's execution authority tells its Agent session. */
export interface SessionExecutionRecord {
    /** The command whose prompt the Session's Agent holds. */
    readonly agentCommand: (target: NativeSessionTarget) => string | undefined;
    /** The Session's settled turns, which a replayed history places among the Agent's own events. */
    readonly settledTurns: (target: NativeSessionTarget) => readonly SettledTurn[];
}

type SessionLoadState =
    | { readonly kind: "not-requested" }
    | {
          readonly completion: Promise<LoadedSession>;
          readonly history: HistoryReplayCapture;
          readonly kind: "capturing";
      }
    | LoadedSession;

type NativeHistoryOwnership =
    | { readonly kind: "unbound" }
    | { readonly kind: "fresh-session" }
    | { readonly kind: "agent-owned" };

/** The native conversation entry this process continues from, recorded after its own writes settle. */
type NativeHistoryBaseline =
    | { readonly kind: "unavailable" }
    | { readonly kind: "recording"; readonly completion: Promise<void> }
    | { readonly kind: "recorded"; readonly latestEntryId: string };

interface LoadedSession {
    readonly history: HistoryReplayCapture;
    readonly kind: "loaded";
    readonly opened: AdapterSessionOpened;
}

type SessionAddress =
    | { readonly kind: "awaiting-native" }
    | { readonly kind: "established"; readonly target: NativeSessionTarget };

export class AgentSession implements AgentSessionRestore {
    // The restore surface: AgentSessionRestore members expose private state to
    // session-restore.ts only. The class keeps the fields private.
    get harness(): string {
        return this.#harness;
    }
    get capabilities(): SessionCapabilities {
        return this.#capabilities;
    }
    get cwd(): string {
        return this.#cwd;
    }
    get metrics(): OperationMetrics {
        return this.#metrics;
    }
    get restored(): boolean {
        return this.#restored;
    }
    get target(): NativeSessionTarget {
        if (this.#address.kind === "established") {
            return this.#address.target;
        }
        if (this.#nativeIdentity.kind === "bound") {
            return { harness: this.#harness, sessionId: this.#nativeIdentity.sessionId };
        }
        throw new AcpExecutionError("The harness has not established a Session", {}, "invalid_agent_session");
    }
    get store(): SessionStore {
        return this.#store;
    }

    readonly hasBackgroundActivity = (): boolean => this.#backgroundActivity !== "none";
    #backgroundActivity: BackgroundActivity = "none";
    /** The command whose prompt the Agent is running, which only the Agent can report as delegated. */
    #delegableCommandId: string | null = null;
    #modelEffort: AgentModelEffort | null = null;
    readonly #scope: AdapterSessionScope;
    readonly #subscriber: AdapterSessionSubscriber;
    #nativeIdentity: { readonly kind: "unbound" } | { readonly kind: "bound"; readonly sessionId: string } = {
        kind: "unbound",
    };
    get #sessionId(): string {
        return this.#nativeIdentity.kind === "bound" ? this.#nativeIdentity.sessionId : "";
    }
    readonly #adapter: Adapter;
    readonly #harness: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => SessionObserver;
    readonly #agentCommand: () => string | undefined;
    readonly #settledTurns: () => readonly SettledTurn[];
    readonly #interactions: SessionInteractions;
    readonly #address: SessionAddress;
    readonly #metrics: OperationMetrics;
    readonly #store: SessionStore;
    #agentName = "";
    #agentVersion = "";
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    readonly #configurationChanges = new SerialTaskQueue();
    #configOptions: readonly SessionConfigOption[] = [];
    readonly #sessionConfigurations = new SessionConfigurations();
    #nativeHistoryOwnership: NativeHistoryOwnership = { kind: "unbound" };
    #nativeHistoryBaseline: NativeHistoryBaseline = { kind: "unavailable" };
    #nativeHistoryWrites = 0;
    #prompted = false;
    #sessionLoad: SessionLoadState = { kind: "not-requested" };
    #restored = false;
    #sessionTitle: string | null = null;
    #sessionUpdatedAt = "";

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        address: SessionAddress,
        getObserver: () => SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
        externalize: SessionPrepareOptions["externalizeSessionUpdate"],
    ) {
        this.#agentCommand = () => execution.agentCommand(this.target);
        this.#settledTurns = () => execution.settledTurns(this.target);
        this.#adapter = adapter;
        this.#harness = agent.harness;
        this.#commands = [];
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#address = address;
        this.#metrics = metrics;
        this.#store = store;
        this.#getObserver = getObserver;
        this.#interactions = new SessionInteractions({
            cwd: () => this.#cwd,
            getToolCall: (toolCallId) => this.#store.events.getToolCall(this.target, toolCallId),
            target: () => this.target,
            commandId: () => this.#agentCommand() ?? SESSION_CONTROL_COMMAND_ID,
            assertNativeSession: this.assertNativeSession,
            observer: getObserver,
            recordSessionEvent: this.recordLifecycleEvent,
        });
        this.#scope = {
            agent,
            cwd,
            ...(externalize === undefined
                ? {}
                : {
                      externalizeUpdate: (sessionId, update, signal) => {
                          if (this.#nativeIdentity.kind === "unbound") {
                              this.selectNativeSession(sessionId);
                          } else {
                              this.assertNativeSession(sessionId);
                          }
                          return externalize(this.target, update, signal);
                      },
                  }),
        };
        this.#subscriber = {
            onSessionEvent: async (sessionId, event) => {
                if (this.#sessionId.length === 0) {
                    this.selectNativeSession(sessionId);
                } else {
                    this.assertNativeSession(sessionId);
                }
                await this.#processEvent(event);
            },
            onBackgroundActivity: (activity) => {
                const previous = this.#backgroundActivity;
                this.#backgroundActivity = activity;
                this.#getObserver().onBackgroundActivity?.(this, activity);
                if (previous !== "none" && activity === "none") {
                    // Background work may have appended to native history on this process's behalf.
                    void this.#recordNativeHistoryRevision();
                }
            },
            onPromptDelegation: async (stage) => {
                // Only the prompt this Session is running can be delegated; a late report has no command to name.
                const commandId = this.#delegableCommandId;
                if (commandId !== null) {
                    await this.recordLifecycleEvent({
                        payload: { commandId, kind: "prompt.delegated", stage },
                        type: "lifecycle-metadata",
                    });
                }
            },
            interactions: {
                onPermission: this.#interactions.onPermission,
                onElicitation: this.#interactions.onElicitation,
                onElicitationComplete: this.#interactions.onElicitationComplete,
            },
        };
    }

    static async #start(
        options: SessionCreationOptions,
        address: SessionAddress,
        getObserver: () => SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        initialize: (runtime: AgentSession) => Promise<void>,
        metrics: OperationMetrics,
        adapter: Adapter,
    ): Promise<AgentSession> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await metrics.measure(
                "executable-validation",
                async () => await validateAgentRuntime(options.agent, options.signal),
            );
            const runtime = metrics.measureSync(
                "process-spawn",
                () =>
                    new AgentSession(
                        options.agent,
                        options.cwd,
                        address,
                        getObserver,
                        execution,
                        store,
                        metrics,
                        adapter,
                        options.externalizeSessionUpdate,
                    ),
            );
            try {
                await initialize(runtime);
                return runtime;
            } catch (error) {
                try {
                    await runtime.closeProcess();
                } finally {
                    if (address.kind === "awaiting-native" && runtime.#nativeIdentity.kind === "bound") {
                        store.remove(runtime.target);
                    }
                }
                options.signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${options.agent.harness}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", {
                    cause: error,
                });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    }

    static readonly start = async (
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        getObserver: () => SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "established", target: options.target },
            getObserver,
            execution,
            store,
            async (runtime) => {
                runtime.#capabilities = capabilities;
                await runtime.initialize(options.signal, recovery, options.origin);
            },
            metrics,
            adapter,
        );

    static readonly create = async (
        options: SessionCreationOptions,
        getObserver: () => SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "awaiting-native" },
            getObserver,
            execution,
            store,
            async (runtime) => {
                const opened = await runtime.#writeNativeHistory(
                    async () => await runtime.createSession(options.signal),
                );
                runtime.selectNativeSession(opened.sessionId);
                runtime.setNativeHistoryOwnership({ kind: "fresh-session" });
                runtime.applySessionOpened(opened);
                options.signal.throwIfAborted();
                runtime.writeStoredSession(new Date().toISOString());
            },
            metrics,
            options.adapter,
        );

    static readonly fork = async (
        options: SessionCreationOptions,
        origin: Extract<NativeSessionOrigin, { readonly kind: "fork" }>,
        capabilities: SessionCapabilities,
        getObserver: () => SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "awaiting-native" },
            getObserver,
            execution,
            store,
            async (runtime) => {
                runtime.#capabilities = capabilities;
                const source = store.read({ harness: options.agent.harness, sessionId: origin.sessionId });
                const opened = await runtime.#writeNativeHistory(
                    async () => await runtime.forkSession(origin.sessionId, options.signal),
                );
                if (opened.sessionId === origin.sessionId) {
                    throw new AcpExecutionError(
                        "The harness did not create an independent fork",
                        {},
                        "invalid_native_session_response",
                    );
                }
                runtime.selectNativeSession(opened.sessionId);
                runtime.applySessionOpened(opened);
                runtime.setSessionTitle(origin.title);
                runtime.setPrompted(true);
                runtime.setRestored(true);
                if (source instanceof FoundStoredSession) {
                    await runtime.restoreStoredConfigurations(source.session, options.signal, "fork");
                }
                options.signal.throwIfAborted();
                runtime.writeStoredSession(new Date().toISOString());
            },
            metrics,
            options.adapter,
        );

    /** A live process keeps the directory it started in; its Agent is the one its target names. */
    readonly runsIn = (cwd: string): boolean => this.#cwd === cwd;

    readonly usesEnvironment = (environment: Readonly<Record<string, string>>): boolean =>
        recordsEqual(this.#environment, environment);

    readonly writeStoredSession = (updatedAt: string): void => {
        this.#store.write(
            new StoredSession(
                this.target,
                this.#cwd,
                this.#prompted,
                this.#sessionTitle ?? "",
                // Agent metadata owns modification time; local activity is only a fallback until it reports one.
                this.#sessionUpdatedAt || updatedAt,
                this.#sessionConfigurations.stored(),
            ),
        );
    };

    /**
     * Applies a client-requested title change. Agents that advertise the
     * `_session/rename` extension receive the new title first so their own
     * session state follows; the daemon then records the rename in the Session
     * event log as an ACP `session_info_update` so every projection and recorded
     * directory observes the same title transition.
     */
    readonly renameSession = async (
        title: string,
        signal: AbortSignal,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> => {
        const normalized = truncate(title, 500);
        if (normalized.length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        const sessionId = this.#sessionId;
        if (sessionId.length > 0) {
            await this.#writeNativeHistory(
                async () => await this.#adapter.renameSession({ ...this.#target(), title: normalized, signal }),
            );
        }
        const updatedAt = new Date().toISOString();
        await this.#processEvent({
            kind: "info",
            changes: [
                { kind: "title", value: normalized },
                { kind: "updated-at", value: updatedAt },
            ],
            payload: { sessionUpdate: "session_info_update", title: normalized, updatedAt },
        });
        return { title: this.#sessionTitle ?? normalized, updatedAt };
    };

    readonly #captureSelectedConfigurationValues = (): void => {
        this.#sessionConfigurations.capture(this.#configOptions);
        if (this.#sessionId.length > 0) {
            this.writeStoredSession(new Date().toISOString());
        }
    };

    readonly restoreStoredConfigurations = async (
        session: StoredSession,
        signal: AbortSignal,
        intent: "restore" | "fork" = "restore",
    ): Promise<void> => {
        await this.#sessionConfigurations.restore(
            session.configurations,
            () => this.#configOptions,
            this.#applyConfiguration,
            signal,
        );
        if (intent === "fork") {
            for (const selection of session.configurations) {
                // Mode carries the Agent's execution/approval constraint. Keep the existing
                // best-effort behavior for model selections that disappear from a catalog.
                if (selection.configId !== "mode") {
                    continue;
                }
                const current = this.#configOptions.find((option) => option.id === selection.configId);
                if (
                    current?.type !== selection.type ||
                    (selection.type === "select"
                        ? current.currentValue !== selection.value
                        : current.booleanValue !== selection.booleanValue)
                ) {
                    throw new AcpExecutionError(
                        "The Agent could not preserve the source Session mode for this Fork",
                        {},
                        "invalid_session_configuration",
                    );
                }
            }
        }
    };

    readonly applySessionOpened = (opened: AdapterSessionOpened): void => {
        this.#agentName = opened.agentName;
        this.#agentVersion = opened.agentVersion;
        this.#modelEffort = opened.agentSettingsModelEffort;
        this.#capabilities = opened.capabilities;
        this.setConfigOptions(opened.configOptions);
    };

    readonly prepared = (): PreparedSession =>
        new PreparedSession(
            this.#agentName,
            this.#agentVersion,
            this.#capabilities,
            this.#commands,
            this.#configOptions,
            this.#prompted,
            this.#restored,
            configurationRevision(this.#configOptions),
        );

    readonly ensureHistoryLoaded = async (signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        await this.#completedHistory(signal);
    };

    readonly loadHistoryEvents = async (
        eventLimit: number,
        cursor: string | null,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        const history = await this.#completedHistory(signal);
        return history.eventPage(eventLimit, cursor);
    };

    async #completedHistory(signal: AbortSignal): Promise<HistoryReplayCapture> {
        if (!this.#prompted && this.#nativeHistoryOwnership.kind === "fresh-session") {
            if (this.#sessionLoad.kind === "not-requested") {
                this.#store.events.reset(this.target);
                this.#sessionLoad = {
                    history: new HistoryReplayCapture(this.#store.events, this.target),
                    kind: "loaded",
                    opened: {
                        sessionId: this.sessionId(),
                        capabilities: this.#capabilities,
                        configOptions: [],
                        agentName: this.#agentName,
                        agentVersion: this.#agentVersion,
                        agentSettingsModelEffort: this.#modelEffort,
                    },
                };
            }
            if (this.#sessionLoad.kind === "loaded") {
                return this.#sessionLoad.history;
            }
        }
        return (await this.#loadSession(signal)).history;
    }

    async #loadSession(signal: AbortSignal): Promise<LoadedSession> {
        if (this.#sessionLoad.kind === "loaded") {
            return this.#sessionLoad;
        }
        if (this.#sessionLoad.kind === "capturing") {
            return await waitForSharedOperation(this.#sessionLoad.completion, signal);
        }
        this.#store.events.reset(this.target);
        const history = new HistoryReplayCapture(this.#store.events, this.target, this.#settledTurns());
        const completion = Promise.resolve().then(async (): Promise<LoadedSession> => {
            try {
                const opened = await this.#writeNativeHistory(
                    async () =>
                        await this.#adapter.openSessionWithReplay({
                            ...this.#sessionParams(signal),
                            sessionId: this.sessionId(),
                        }),
                );
                signal.throwIfAborted();
                this.#capabilities = opened.capabilities;
                history.finishReplay();
                const loaded = { history, kind: "loaded", opened } satisfies LoadedSession;
                this.#sessionLoad = loaded;
                return loaded;
            } catch (cause) {
                this.#sessionLoad = { kind: "not-requested" };
                throw cause;
            }
        });
        this.#sessionLoad = { completion, history, kind: "capturing" };
        return await completion;
    }

    readonly initialize = async (
        signal: AbortSignal,
        recovery: SessionRecovery,
        origin?: NativeSessionOrigin,
    ): Promise<void> =>
        await this.#writeNativeHistory(async () => await restoreSession(this, signal, recovery, origin));

    /**
     * Native clients, such as the Agent's own terminal, can continue the conversation
     * while this process is idle. The Agent would then answer from, and append to, the
     * copy it loaded earlier, so the caller must reopen the conversation from native history.
     */
    readonly nativeHistoryChanged = async (signal: AbortSignal): Promise<boolean> => {
        const baseline = this.#nativeHistoryBaseline;
        if (this.#writingNativeHistory()) {
            return false;
        }
        switch (baseline.kind) {
            case "unavailable":
                return false;
            case "recording":
                await waitForSharedOperation(baseline.completion, signal);
                return await this.nativeHistoryChanged(signal);
            case "recorded": {
                let current: NativeHistoryRevision;
                try {
                    current = await this.#readNativeHistoryRevision(signal);
                } catch (error) {
                    signal.throwIfAborted();
                    console.warn(`[${this.#harness}-acp] Native history revision could not be read`, error);
                    return false;
                }
                // Our own writes that began meanwhile record a new baseline when they settle.
                return (
                    !this.#writingNativeHistory() &&
                    this.#nativeHistoryBaseline === baseline &&
                    current.kind === "tracked" &&
                    current.latestEntryId !== baseline.latestEntryId
                );
            }
            default: {
                const unreachable: never = baseline;
                throw new AcpExecutionError("Unexpected native history baseline", { cause: unreachable });
            }
        }
    };

    readonly #writingNativeHistory = (): boolean =>
        this.#nativeHistoryWrites > 0 || this.#backgroundActivity !== "none";

    /**
     * Runs an operation that may append to native history, then records what it left there.
     * The recording starts synchronously; a later comparison waits for it instead of the operation.
     */
    readonly #writeNativeHistory = async <T>(operation: () => Promise<T>): Promise<T> => {
        this.#nativeHistoryWrites += 1;
        try {
            return await operation();
        } finally {
            this.#nativeHistoryWrites -= 1;
            void this.#recordNativeHistoryRevision();
        }
    };

    readonly #readNativeHistoryRevision = async (signal: AbortSignal): Promise<NativeHistoryRevision> =>
        this.#nativeIdentity.kind === "bound"
            ? await this.#adapter.readNativeHistoryRevision({
                  ...this.#target(),
                  signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              })
            : { kind: "untracked" };

    readonly #recordNativeHistoryRevision = async (): Promise<void> => {
        if (this.#writingNativeHistory()) {
            return;
        }
        const recorded = Promise.withResolvers<void>();
        const recording: NativeHistoryBaseline = { kind: "recording", completion: recorded.promise };
        this.#nativeHistoryBaseline = recording;
        let baseline: NativeHistoryBaseline = { kind: "unavailable" };
        try {
            const revision = await this.#readNativeHistoryRevision(AbortSignal.timeout(30_000));
            if (revision.kind === "tracked") {
                baseline = { kind: "recorded", latestEntryId: revision.latestEntryId };
            }
        } catch (error) {
            // A released process has no writer left to compare; any other failure keeps reuse unchanged.
            if (!(error instanceof AcpExecutionError && error.code === "invalid_agent_session")) {
                console.warn(`[${this.#harness}-acp] Native history revision could not be recorded`, error);
            }
        } finally {
            if (this.#nativeHistoryBaseline === recording) {
                this.#nativeHistoryBaseline = baseline;
            }
            recorded.resolve();
        }
    };

    readonly sessionId = (): string => this.#sessionId;

    readonly #applyConfiguration = async (
        selection: SessionConfigurationSelection,
        signal: AbortSignal,
    ): Promise<void> => {
        const before = this.#configOptions;
        const configured = await this.#writeNativeHistory(
            async () => await this.#adapter.configureSession({ ...this.#target(), selection, signal }),
        );
        // An Agent update that arrived meanwhile is newer than this response.
        if (this.#configOptions === before) {
            this.#configOptions = configured;
            await this.#publishConfiguration();
        }
    };

    // The revision check and Agent mutation share one queue with the settings the Runtime applies itself.
    // A lost response may have committed: reread after a conflict, never replay an edit blindly.
    readonly configure = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#configurationChanges.run(async (signal) => {
            if (options.expectedConfigurationRevision !== configurationRevision(this.#configOptions)) {
                throw new AcpExecutionError(
                    "Session settings changed. Review the current settings before applying your selection again.",
                    {},
                    "session_configuration_conflict",
                );
            }
            return await this.#change(options, signal);
        }, options.signal);

    /** Applies a setting the Runtime owns, whatever the configuration's current revision. */
    readonly applyConfiguration = async (change: SessionConfigurationChange): Promise<SessionConfigurationSnapshot> =>
        this.#configurationChanges.run(async (signal) => await this.#change(change, signal), change.signal);

    readonly #change = async (
        change: SessionConfigurationChange,
        signal: AbortSignal,
    ): Promise<SessionConfigurationSnapshot> => {
        await this.#applyConfiguration(
            change.valueType === "boolean"
                ? { type: "boolean", configId: change.configId, booleanValue: change.booleanValue }
                : { type: "select", configId: change.configId, value: change.value },
            signal,
        );
        const applied = this.#configOptions.find((option) => option.id === change.configId);
        if (applied === undefined) {
            throw new AcpExecutionError("The requested ACP configuration option is unavailable");
        }
        this.#sessionConfigurations.select(applied);
        this.writeStoredSession(new Date().toISOString());
        return {
            configOptions: this.#configOptions,
            configurationRevision: configurationRevision(this.#configOptions),
        };
    };

    readonly #publishConfiguration = async (): Promise<void> => {
        // Use the existing v2 ACP event vocabulary so old observers can still decode the stream.
        const event = this.#store.events.append(this.target, {
            type: "acp",
            payload: {
                sessionUpdate: "config_option_update",
                configOptions: this.#configOptions.map((option) => ({
                    category: option.category,
                    description: option.description,
                    id: option.id,
                    name: option.name,
                    ...(option.type === "boolean"
                        ? { type: "boolean" as const, currentValue: option.booleanValue }
                        : { type: "select" as const, currentValue: option.currentValue, options: option.values }),
                })),
            },
        });
        await this.#getObserver().onSessionEvent?.(event);
        await this.emitConfigUpdate();
    };

    readonly #target = (): AdapterSessionTarget => ({
        sessionId: this.#sessionId,
        cwd: this.#cwd,
    });

    /** Loads what the Agent needs before it can receive a prompt; the Agent does not receive it yet. */
    readonly preparePrompt = async (signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.loadSession && this.#sessionLoad.kind === "not-requested") {
            this.#sessionLoad = {
                kind: "loaded",
                history: new HistoryReplayCapture(this.#store.events, this.target),
                opened: {
                    sessionId: this.sessionId(),
                    capabilities: this.#capabilities,
                    configOptions: [],
                    agentName: this.#agentName,
                    agentVersion: this.#agentVersion,
                    agentSettingsModelEffort: this.#modelEffort,
                },
            };
        }
        if (this.#capabilities.loadSession) {
            await this.#completedHistory(signal);
        }
    };

    /**
     * Hands a prepared prompt to the Agent. Precondition: `preparePrompt` completed and the Session's execution
     * authority records this command as started. `cancellationRequested` reads that authority's cancellation of it.
     */
    readonly prompt = async (
        options: SessionTurnOptions & { readonly cancellationRequested: () => boolean },
    ): Promise<PromptResult> => {
        validatePromptContent(options, this.#capabilities);
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
        if (this.#sessionTitle === null || this.#sessionTitle.length === 0) {
            this.#sessionTitle = conversationTitleFromText(options.prompt);
        }
        this.#prompted = true;
        this.writeStoredSession(new Date().toISOString());
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        this.#delegableCommandId = lifecycle === undefined ? null : options.commandId;
        try {
            const result = await this.#writeNativeHistory(async () => {
                try {
                    return await this.#adapter.prompt({ ...this.#target(), content: options, signal: options.signal });
                } finally {
                    // The prompt's terminal event follows; nothing may be recorded for it after that.
                    this.#delegableCommandId = null;
                }
            });
            this.writeStoredSession(new Date().toISOString());
            if (lifecycle !== undefined) {
                const messageId = result._meta?.messageId;
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        ...(messageId === undefined ? {} : { messageId }),
                        stopReason: result.stopReason,
                    },
                    type: "lifecycle-metadata",
                });
            }
            return result;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                const message = failure instanceof AcpPromptExecutionError ? { messageId: failure.messageId } : {};
                await this.recordLifecycleEvent({
                    payload: options.cancellationRequested()
                        ? {
                              commandId: options.commandId,
                              kind: "prompt.completed",
                              ...message,
                              stopReason: "cancelled",
                          }
                        : {
                              attemptId: lifecycle.attemptId,
                              code: failure.code,
                              commandId: options.commandId,
                              kind: "prompt.failed",
                              message: truncate(failure.message, 500),
                              ...message,
                          },
                    type: "lifecycle-metadata",
                });
            }
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw failure;
        }
    };

    /**
     * Adds a steering prompt to the prompt the Agent holds. Precondition: the Session's execution authority accepts
     * steering into `options.targetCommandId`.
     */
    readonly steer = async (options: SessionSteerOptions): Promise<string> => {
        if (!this.#capabilities.steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        validatePromptContent(options, this.#capabilities);
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        try {
            const outcome = await this.#adapter.steer({ ...this.#target(), content: options, signal: options.signal });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        // The steering's own user message, so a reloaded history shows it inside the turn it joined.
                        ...(outcome.outcome === "injected" && outcome.messageId !== undefined
                            ? { messageId: outcome.messageId }
                            : {}),
                        stopReason: "steered",
                    },
                    type: "lifecycle-metadata",
                });
            }
            return outcome.outcome;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        attemptId: lifecycle.attemptId,
                        code: failure.code,
                        commandId: options.commandId,
                        kind: "prompt.failed",
                        message: truncate(failure.message, 500),
                    },
                    type: "lifecycle-metadata",
                });
            }
            throw failure;
        }
    };

    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        await this.#interactions.cancelPendingInteractions();
        signal.throwIfAborted();
        if (this.#agentCommand() !== undefined) {
            return await this.#adapter.cancel({ ...this.#target(), signal });
        }
        return "retained";
    };

    readonly interactionSnapshot = (): SessionInteractionSnapshot => {
        const { sessionGenerationId, throughPosition } = this.#store.events.livePosition(this.target);
        return { sessionGenerationId, throughPosition, interactions: this.#interactions.snapshot() };
    };

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        await this.#interactions.respondPermission(options);
    };
    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        await this.#interactions.respondElicitation(options);
    };

    readonly recordControlEvent = async (event: SessionEventPayload): Promise<boolean> => {
        if (this.#sessionLoad.kind !== "loaded") {
            return false;
        }
        await this.recordLifecycleEvent(event);
        return true;
    };

    readonly recordLifecycleEvent = async (event: SessionEventPayload): Promise<void> => {
        if (event.type !== "lifecycle-metadata" || this.#sessionLoad.kind !== "loaded") {
            return;
        }
        const liveEvent = this.#sessionLoad.history.recordLifecycle(event);
        await this.#getObserver().onSessionEvent?.(liveEvent);
    };

    readonly selectNativeSession = (sessionId: string): void => {
        if (
            this.#address.kind === "awaiting-native" &&
            this.#nativeIdentity.kind === "unbound" &&
            (!isIdentifier(sessionId) ||
                !(this.#store.read({ harness: this.#harness, sessionId: sessionId }) instanceof MissingStoredSession))
        ) {
            throw new AcpExecutionError(
                "The Agent returned an invalid new Session ID",
                {},
                "invalid_native_session_response",
            );
        }
        if (this.#sessionId.length > 0 && this.#sessionId !== sessionId) {
            throw new AcpExecutionError(
                "ACP agent attempted to replace the selected session",
                {},
                "invalid_agent_session",
            );
        }
        if (
            this.#address.kind === "established" &&
            !sameNativeSession(this.#address.target, { harness: this.#harness, sessionId: sessionId })
        ) {
            throw new AcpExecutionError(
                "The harness returned a different native Session",
                {},
                "session_identity_mismatch",
            );
        }
        this.#nativeIdentity = { kind: "bound", sessionId: sessionId };
        this.#nativeHistoryOwnership = { kind: "agent-owned" };
    };

    readonly #processEvent = async (event: AdapterSessionEvent): Promise<void> => {
        if (event.kind === "configuration" || event.kind === "mode") {
            this.#configOptions =
                event.kind === "configuration"
                    ? event.configOptions
                    : this.#configOptions.map((option) =>
                          option.category === "mode" ? { ...option, currentValue: event.modeId } : option,
                      );
            this.#captureSelectedConfigurationValues();
        }
        if (this.#sessionLoad.kind === "capturing") {
            this.#sessionLoad.history.replay(event.payload);
        } else if (this.#sessionLoad.kind === "loaded") {
            await this.#sessionLoad.history.record(event.payload, async (liveEvent) => {
                await this.#getObserver().onSessionEvent?.(liveEvent);
            });
        }
        switch (event.kind) {
            case "content":
            case "other":
                return;
            case "commands":
                this.#commands = event.commands;
                await this.#getObserver().onCommands({
                    commands: this.#commands,
                    kind: SESSION_COMMANDS_UPDATED_KIND,
                    target: this.target,
                });
                return;
            case "configuration":
            case "mode":
                await this.emitConfigUpdate();
                return;
            case "info": {
                for (const change of event.changes) {
                    switch (change.kind) {
                        case "title":
                            this.#sessionTitle = change.value;
                            break;
                        case "updated-at":
                            this.#sessionUpdatedAt = change.value;
                            break;
                    }
                }
                const updatedAt = this.#sessionUpdatedAt || new Date().toISOString();
                if (this.#sessionId.length > 0) {
                    this.writeStoredSession(updatedAt);
                }
                await this.#getObserver().onInfo({
                    kind: SESSION_INFO_UPDATED_KIND,
                    target: this.target,
                    title: this.#sessionTitle,
                    updatedAt,
                });
                return;
            }
        }
    };

    readonly close = async (): Promise<void> => {
        try {
            await this.#interactions.cancelPendingInteractions();
        } catch (error) {
            try {
                throw error;
            } finally {
                await this.closeProcess();
            }
        }
        if (this.#sessionId.length === 0) {
            await this.closeProcess();
            return;
        }
        await this.#adapter.closeSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
    };

    readonly closeProcess = async (): Promise<void> => {
        if (this.#nativeIdentity.kind === "bound") {
            await this.#adapter.releaseSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
        }
        this.#backgroundActivity = "none";
    };

    readonly agentSettingsModelEffort = () => this.#modelEffort;
    readonly #sessionParams = (signal: AbortSignal): AdapterSessionCreateParams => ({
        ...this.#subscriber,
        scope: this.#scope,
        signal,
    });
    readonly createSession = (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.createSession(this.#sessionParams(signal));

    readonly forkSession = (sourceSessionId: string, signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.forkSession({ ...this.#sessionParams(signal), sourceSessionId: sourceSessionId });

    readonly openSession = (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        this.#adapter.openSession({ ...this.#sessionParams(signal), sessionId: this.sessionId() });

    readonly openSessionWithReplay = async (signal: AbortSignal): Promise<AdapterSessionOpened> =>
        (await this.#loadSession(signal)).opened;

    setConfigOptions(options: readonly SessionConfigOption[]): void {
        this.#configOptions = options;
    }

    setNativeHistoryOwnership(ownership: NativeHistoryOwnership): void {
        this.#nativeHistoryOwnership = ownership;
    }

    setPrompted(prompted: boolean): void {
        this.#prompted = prompted;
    }

    setRestored(restored: boolean): void {
        this.#restored = restored;
    }

    setSessionTitle(title: string): void {
        this.#sessionTitle = title;
    }

    readonly assertNativeSession = (sessionId: string): void => {
        if (sessionId !== this.#sessionId) {
            throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
        }
    };

    readonly emitConfigUpdate = async (): Promise<void> => {
        await this.#getObserver().onConfig({
            configOptions: this.#configOptions,
            configurationRevision: configurationRevision(this.#configOptions),
            kind: SESSION_CONFIG_UPDATED_KIND,
            requestId: `agent-update-${crypto.randomUUID()}`,
            target: this.target,
        });
    };
}
