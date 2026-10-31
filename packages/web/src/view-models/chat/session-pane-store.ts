import {
    MobiusApiError,
    type MobiusClient,
    MobiusElicitationResponseRequest,
    MobiusError,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    type MobiusSessionEventObserver,
    MobiusTimeoutError,
    type PromptAttachment,
    SESSION_CLOSED_ERROR_CODE,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import type { SessionEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { registerMortyDebugSession } from "../../debug-bridge.ts";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import { saveLastHarnessPreference } from "../../services/chat/last-harness-preference.ts";
import { recordBrowserDiagnostic } from "../../services/diagnostics/browser-diagnostics.ts";
import { centralIndexedDB, sessionLastSentMessageEntry } from "../../services/indexed-db/central-indexed-db.ts";
import { centralSessionStorage, sessionDraftEntry } from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableRuntimeConnectionFailure, isSessionClosedFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import type { ComposerAttachmentStore } from "./composer-attachment-store.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import type { SelectedMobiusSession } from "./open-session.ts";
import { uploadPromptAttachment, uploadPromptAttachments } from "./prompt-attachment-upload.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";
import { type SessionActivityState, workingCommandId } from "./session-activity-machine.ts";
import {
    connectionFailure,
    connectionWaitsForRuntime,
    disconnectedConnection,
    isConnectionSettled,
    type SessionConnection,
    sessionReconnectAttempt,
    sessionUpdatesEndedError,
} from "./session-connection.ts";
import {
    acceptedTurn,
    type CurrentTurn,
    type CurrentTurnEvent,
    idleTurn,
    openedTurn,
    sessionActivity,
    transitionCurrentTurn,
} from "./session-current-turn.ts";
import { sessionDebugBlocks } from "./session-debug-blocks.ts";
import { sessionDeliveryPresentation } from "./session-delivery-presentation.ts";
import {
    awaitingMessage,
    type DeliveryTarget,
    deliveryMessages,
    journalMessage,
    prependToDraft,
    type SessionDeliveryStore,
    type SubmitTurn,
    type SubmittedMessage,
} from "./session-delivery-store.ts";
import { observeSessionExecution, type QueuedCommand, type SessionExecutionObservation } from "./session-execution.ts";
import { createSessionInteractionStore, type SessionInteractionStore } from "./session-interaction-store.ts";
import { type SessionLifecycleFact, sessionInteractionRecovery, sessionLifecycleFact } from "./session-lifecycle.ts";
import { queuedMessages, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import {
    canChangeSettings,
    canQueue,
    canRetryFailedMessage,
    canRetryUnknownDelivery,
    canSendNow,
    canSubmit,
    composerHasMessage,
    type SessionOperationFacts,
} from "./session-operation-rules.ts";
import type { ElicitationInteractionResponse, PermissionInteractionResponse } from "./session-pane-types.ts";
import {
    createSessionMessageReduction,
    type SessionExecutionMessage,
    sessionEventCommandIds,
    sessionReductionMessages,
    sessionUserCommandIds,
} from "./session-presentation.ts";
import {
    createSessionProjection,
    type SessionEventHistory,
    type SessionProjection,
    type SessionProjectionEffect,
    type SessionProjectionInput,
    sessionProjectionMessages,
    sessionProjectionPagination,
    transitionSessionProjection,
} from "./session-projection.ts";
import { createSessionSettingsStore } from "./session-settings-store.ts";
import {
    createSessionTaskControlsStore,
    type SessionTaskControlsStore,
    stopFailure,
    stopRequested,
} from "./session-task-controls.ts";
import { type SessionTitlesStore, sessionTitle } from "./session-titles-store.ts";
import { createSessionTurnLedger } from "./session-turn-ledger.ts";
import { createSessionWelcomeStore } from "./session-welcome-store.ts";

/**
 * What views see of a pane: its stores and the user's actions. Starting, stopping and reconnecting the pane is its
 * owner's.
 */
export type SessionPaneModel = Omit<ReturnType<typeof createSessionPaneModel>, "start" | "stop" | "reconnect">;

/** A change to the Session's settings. */
type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "configuring"; readonly configId: string }
    | { readonly kind: "failed"; readonly message: string };

/** Renaming the Session. A failed rename closes the editor and keeps its failure until the next edit. */
export type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string }
    | { readonly kind: "failed"; readonly message: string };

/** Loading the page of history before the oldest message shown. A failure lasts until the next load. */
type OlderHistory =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string };

export type { SessionConnection } from "./session-connection.ts";

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
export interface SessionPaneStore {
    readonly connection: SessionConnection;
    readonly titleEdit: TitleEdit;
    readonly messages: readonly SessionExecutionMessage[];
    readonly olderHistory: OlderHistory;
    readonly historyRevision: number;
    readonly hasOlderHistory: boolean;
    readonly draft: string;
    /** The composer holds an edited queued message whose attachment bytes were unavailable to this viewer. */
    readonly filesRestoreNotice: boolean;
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
    readonly operation: Operation;
    /**
     * The current turn as the service reported it: which command runs, its turn id and when it started, or how the
     * last turn ended. The running turn the stop control acts on is derived from it; the activity the pane shows and
     * reports is derived from it with the delivery of a turn this pane is still submitting.
     */
    readonly turn: CurrentTurn;
    /** The messages the Runtime holds queued, as last observed. The queue panel derives its list from them. */
    readonly queued: readonly QueuedCommand[];
    readonly recover: (signal: AbortSignal) => Promise<void>;
    readonly retryNow: () => void;
    /**
     * Records that the Runtime closed the Session and stops the connection until it is reopened. `reason` is the
     * Runtime's explanation, or null when a failed operation was the only sign of the closing.
     */
    readonly sessionClosed: (reason: string | null) => void;
    /** Reopens a closed Session on the user's request, then connects to it again. */
    readonly reopen: (signal: AbortSignal) => Promise<void>;
    readonly loadOlderMessages: (signal: AbortSignal) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly send: (signal: AbortSignal) => Promise<void>;
    readonly removeUnknownDelivery: () => void;
    /** Retries on the Session's delivery: the attempt may outlive this pane. */
    readonly retryUnknownDelivery: () => Promise<void>;
    readonly retryFailedMessage: (signal: AbortSignal) => Promise<void>;
    readonly editFailedMessage: () => void;
    readonly discardFailedMessage: () => void;
    readonly queueDraft: (signal: AbortSignal) => Promise<void>;
    readonly steerQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly deleteQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    /** Takes a queued message out of the queue and back into the composer, ahead of any draft, for editing. */
    readonly editQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly configure: (
        option: SessionConfigOption,
        value: string,
        booleanValue: boolean,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly openTitleEdit: () => void;
    readonly setTitleDraft: (draft: string) => void;
    readonly confirmTitleEdit: (signal: AbortSignal) => Promise<void>;
    readonly cancelTitleEdit: () => void;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

/** The pane's state with its connection loop, which only the pane's own `start` runs. */
interface SessionPaneState extends SessionPaneStore {
    readonly connect: (signal: AbortSignal) => Promise<void>;
}

function waitingForInput(interactions: Pick<SessionInteractionStore, "interactions">): boolean {
    return interactions.interactions.some(
        (interaction) =>
            (interaction.kind === "permission" && interaction.permission.state.kind !== "resolved") ||
            (interaction.kind === "elicitation" &&
                (interaction.elicitation.state.kind === "pending" ||
                    interaction.elicitation.state.kind === "submitted")),
    );
}

/** The pane's state as the operation rules read it, for the presentation and the actions alike. */
function sessionOperationFacts(
    model: Pick<SessionPaneStore, "connection" | "operation" | "turn">,
    delivery: Pick<SessionDeliveryStore, "state">,
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    interactions: Pick<SessionInteractionStore, "interactions">,
    connectionAvailable: boolean,
): SessionOperationFacts {
    return {
        connectionAvailable,
        connection: model.connection.kind,
        turn: model.turn,
        stopping: stopRequested(tasks, acceptedTurn(model.turn)),
        configuring: model.operation.kind === "configuring",
        delivery: delivery.state.kind,
        waitingForInput: waitingForInput(interactions),
    };
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
    attachments: ComposerAttachmentStore,
    interactions: SessionInteractionStore,
    connectionAvailable: boolean,
) {
    const facts = sessionOperationFacts(model, delivery, tasks, interactions, connectionAvailable);
    const activity = sessionActivity(model.turn, delivery.state);
    // Which turn runs is the current turn's; the stop control only adds whether the user asked to stop it.
    const controlRunning = acceptedTurn(model.turn) !== null;
    const stopping = facts.stopping;
    // While a turn runs, the composer queues behind it until the user asks to stop it.
    const shouldQueueOnSubmit = controlRunning && !stopping;
    const composerInputDisabled =
        model.connection.kind === "closed" ||
        model.operation.kind === "configuring" ||
        facts.waitingForInput ||
        stopping;
    const activeCommandId = workingCommandId(activity);
    const activeMessageId =
        activeCommandId !== null
            ? (model.messages.findLast((message) => message.role === "assistant")?.firstEvent.eventId ?? null)
            : null;
    const unknownDelivery = delivery.state.kind === "delivery-unknown" ? journalMessage(delivery.state.journal) : null;
    const deliveryUnknownCommandId = unknownDelivery?.commandId ?? null;
    const deliveryUnknownUserMessageId = deliveryUnknownCommandId === null ? null : deliveryUnknownCommandId;
    const deliveries = sessionDeliveryPresentation(model.messages, model.queued, delivery, queue);
    const pendingMessage = deliveries.pendingDelivery?.message ?? null;
    const pendingDelivery = deliveries.pendingDelivery;
    const hasFailureCard =
        activity.kind === "failed" &&
        model.messages.some(
            (message) =>
                message.commandId === activity.commandId &&
                message.role === "assistant" &&
                message.presentation.kind === "failure",
        );
    const authenticationFailure =
        model.connection.kind !== "closed" &&
        activity.kind === "failed" &&
        activity.code === "authentication_required" &&
        !hasFailureCard
            ? activity
            : null;
    return {
        activity,
        authenticationFailure,
        activeMessageId,
        activeCommandId,
        composerInputDisabled,
        settingsDisabled: !canChangeSettings(facts),
        settingsNotice: controlRunning ? "New settings may not affect this response." : null,
        settingsStopDisabled: !connectionAvailable || model.connection.kind !== "ready" || stopping,
        stopDisabled: !connectionAvailable || model.connection.kind !== "ready",
        canSuggestProgress:
            canSendNow(facts) &&
            model.draft.length === 0 &&
            attachments.attachments.length === 0 &&
            attachments.state.kind !== "reading",
        // Operations that failed because the Session closed say nothing the closed notice does not already say.
        composerError:
            model.connection.kind === "closed" || pendingDelivery?.error != null
                ? ""
                : ([
                      activity,
                      model.titleEdit,
                      model.olderHistory,
                      model.operation,
                      delivery.state.kind === "failed"
                          ? { kind: "failed" as const, message: delivery.state.failure.message }
                          : delivery.state,
                  ]
                      .filter((state) => state.kind === "failed")
                      .find(
                          (state) =>
                              // A turn failure belongs to its timeline card. Keep the
                              // composer fallback only when that command has no card.
                              !("commandId" in state) || (!hasFailureCard && authenticationFailure === null),
                      )?.message ??
                  stopFailure(tasks) ??
                  (queue.feedback.kind === "failed" ? queue.feedback.message : "")),
        controlRunning,
        deliveryUnknownUserMessageId,
        hasOlderHistory: model.hasOlderHistory,
        historyLoading: model.olderHistory.kind === "loading",
        outputState:
            delivery.state.kind === "preparing"
                ? "sending"
                : stopping
                  ? "stopping"
                  : delivery.state.kind === "submitting"
                    ? "sending"
                    : controlRunning
                      ? "running"
                      : "idle",
        // The working timer counts from when the running turn's work started.
        workingIndicator:
            facts.waitingForInput || model.turn.kind !== "current" ? null : { startedAt: model.turn.startedAt },
        shouldQueueOnSubmit,
        retryFailedDisabled: pendingMessage === null || !canRetryFailedMessage(pendingMessage.target, facts),
        retryUnknownDeliveryDisabled:
            unknownDelivery === null || !canRetryUnknownDelivery(unknownDelivery.target, facts),
        submitDisabled:
            !composerHasMessage(model.draft, attachments.attachments.length, attachments.state.kind === "reading") ||
            !(shouldQueueOnSubmit ? canQueue(facts) : canSendNow(facts)),
        ...deliveries,
    } as const;
}

interface SessionIdentity {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
}

async function readSessionHistory(
    client: MobiusClient,
    sessionId: string,
    initialCursor: string | null,
    newerEvents: readonly SessionEvent[],
    expectedSessionGenerationId: string | null,
    signal: AbortSignal,
    loadedRange: { readonly generation: string; readonly firstEventId: string | null } | null = null,
): Promise<SessionEventHistory> {
    let events: readonly SessionEvent[] = newerEvents;
    let nextCursor = initialCursor;
    // Loading the newest page can itself restore native history and replace the
    // generation announced by a preceding live event. That page owns the baseline;
    // only older pages must match the generation we have already adopted.
    let sessionGenerationId = initialCursor === null ? null : expectedSessionGenerationId;
    let throughPosition: string | null = null;
    let renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    do {
        const requestedCursor = nextCursor;
        const page = await client.events.list(
            sessionId,
            new MobiusPageRequest(SESSION_EVENT_PAGE_LIMIT, requestedCursor ?? ""),
            signal,
        );
        signal.throwIfAborted();
        // Only the newest page defines which live deltas the snapshot covers.
        if (requestedCursor === initialCursor) {
            throughPosition = page.throughPosition;
        }
        if (sessionGenerationId !== null && page.sessionGenerationId !== sessionGenerationId) {
            throw new Error("The Session reloaded while message history was loading.");
        }
        if (requestedCursor !== null && page.nextCursor === requestedCursor) {
            throw new Error("The Runtime returned the same message-history cursor twice.");
        }
        sessionGenerationId = page.sessionGenerationId;
        events = mergeSessionEvents(page.events, events);
        nextCursor = page.nextCursor;
        renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    } while (
        nextCursor !== null &&
        (renderableMessages.length < HISTORY_MESSAGE_TARGET ||
            (loadedRange !== null &&
                loadedRange.generation === sessionGenerationId &&
                loadedRange.firstEventId !== null &&
                !events.some((event) => event.eventId === loadedRange.firstEventId)))
    );
    if (sessionGenerationId === null || throughPosition === null) {
        throw new Error("The Runtime returned no Session history generation.");
    }
    return { events, nextCursor, sessionGenerationId, throughPosition };
}

function mergeSessionEvents(
    current: readonly SessionEvent[],
    incoming: readonly SessionEvent[],
): readonly SessionEvent[] {
    const byId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
        byId.set(event.eventId, event);
    }
    return [...byId.values()];
}

export function createSessionPaneModel(options: {
    readonly clock: Clock;
    readonly session: SelectedMobiusSession;
    readonly composerAttachments: StoreApi<ComposerAttachmentStore>;
    readonly attachmentSignal: AbortSignal;
    readonly delivery: StoreApi<SessionDeliveryStore>;
    readonly messageQueue: StoreApi<SessionMessageQueueStore>;
    readonly botId: string;
    readonly requests: Pick<
        BotChatApi,
        | "connectSession"
        | "managedSession"
        | "runtimeConfiguration"
        | "recoverBridge"
        | "waitForBridge"
        | "resetSessionConnections"
    >;
    /**
     * Hands the owner this pane's last account of the Session's work when the pane stops. While it runs, the owner
     * derives the Session's status from the pane's turn instead.
     */
    readonly onReleased?: ((activity: SessionActivityState) => void) | undefined;
    readonly titles: SessionTitlesStore;
    /** Whether the connection header reports this Session's connection available, network and Machine included. */
    readonly connectionAvailable: (connection: SessionConnection) => boolean;
    /** The connection reached the Session through the Runtime. */
    readonly onConnected: () => void;
    /** The connection used up its automatic retries and waits for the owner's `reconnect`. */
    readonly onWaitingForRuntime: () => void;
}) {
    const { session, botId, requests, clock, composerAttachments, delivery, messageQueue, titles } = options;
    const sessionId = session.result.ready.sessionId;
    // Working in a conversation makes it the reference for the next draft: its
    // harness and the settings it runs with carry into New Session.
    saveLastHarnessPreference(botId, session.agentRef);
    saveLastAgentSettings(botId, session.agentRef, session.result.ready.configOptions);
    const settings = createSessionSettingsStore({
        botId,
        agentRef: session.agentRef,
        initial: session.result.ready,
    });
    const fallbackStartedAt = Date.now();
    const initialTurn: CurrentTurn =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? openedTurn({
                  commandId: session.result.activeTurn.commandId,
                  turnId: session.result.activeTurn.turnId,
                  startedAt: fallbackStartedAt,
              })
            : idleTurn;
    const turns = createSessionTurnLedger();
    let client: MobiusClient | null = null;
    let recoveryRequested = false;
    let countdownInterrupt: AbortController | null = null;
    // The Runtime closed the Session. The connect loop turns this into the closed connection state.
    let closure: { readonly reason: string | null } | null = null;
    // The running connection attempt, which a closing of the Session interrupts.
    let attempt: AbortController | null = null;
    // Lets the connect loop go on once the user has reopened the closed Session.
    let resumeAfterReopen: (() => void) | null = null;
    // Counts the times the user reopened the Session. A `session_closed` failure from an operation that began
    // before a reopening describes the Session as it was, so it must not close the reopened Session again.
    let reopenings = 0;
    // The pane's lifetime: its owner starts it once and stops it once, so at most one connection loop ever runs for
    // the pane. React attaching or detaching its view is not part of it.
    const lifetime = new AbortController();
    let phase: "created" | "started" | "stopped" = "created";
    /** Whether a failure says the Session is closed now, not just as it was when the operation began. */
    const closedNow = (cause: unknown, reopeningsAtStart: number): boolean =>
        isSessionClosedFailure(cause) && reopeningsAtStart === reopenings;
    /** Wraps an operation on the Session so that failing because the Session closed also closes this pane. */
    const noticingClosure =
        <Arguments extends readonly unknown[], Result>(operation: (...args: Arguments) => Promise<Result>) =>
        async (...args: Arguments): Promise<Result> => {
            const reopeningsAtStart = reopenings;
            try {
                return await operation(...args);
            } catch (cause) {
                if (closedNow(cause, reopeningsAtStart)) {
                    store.getState().sessionClosed(null);
                }
                throw cause;
            }
        };
    let projection = createSessionProjection();
    let loadingOlderHistory = false;
    const instructionUri = "morty://bot/instructions";
    const withInstructions = async <T extends { readonly attachments: readonly PromptAttachment[] }>(
        connected: MobiusClient,
        request: T,
        signal: AbortSignal,
    ): Promise<T> => {
        const instructions = (session.instructions ?? "").trim();
        if (instructions.length === 0) {
            return request;
        }
        const attachment = await uploadPromptAttachment(
            connected.sessions,
            sessionId,
            {
                bytes: new TextEncoder().encode(instructions),
                kind: "resource",
                mediaType: "text/plain",
                name: "Agent instructions",
                uri: instructionUri,
            },
            signal,
        );
        return {
            ...request,
            attachments: [...request.attachments.filter((item) => item.uri !== instructionUri), attachment],
        };
    };
    /**
     * Submits through the client the attempt started with. Closing a client ends only its live subscriptions, so the
     * attempt keeps its requests when this pane reconnects or stops.
     */
    const submitTurn = (connected: MobiusClient | null): SubmitTurn =>
        noticingClosure(async (request, signal) => {
            if (connected === null) {
                throw new Error("The Session is not connected.");
            }
            return await connected.turns.submit(sessionId, request, signal);
        });
    const lastSentMessageEntry = sessionLastSentMessageEntry(sessionId);
    // The projection is the only source of the timeline; every change to it updates all three fields together.
    const projectedTimeline = (state: SessionProjection) => ({
        hasOlderHistory: sessionProjectionPagination(state) !== null,
        historyRevision: state.revision,
        messages: sessionProjectionMessages(state),
    });
    const tasks = createSessionTaskControlsStore({
        clock,
        steeringSupported: session.result.ready.capabilities.steering,
        port: {
            cancel: noticingClosure(async (turnId, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                await client.turns.cancel(sessionId, turnId, signal);
            }),
        },
        runningTurn: () => acceptedTurn(store.getState().turn),
    });
    const queuePort = {
        cancel: noticingClosure(async (turnId: string, signal: AbortSignal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            await client.turns.cancelQueued(sessionId, turnId, signal);
        }),
        steer: noticingClosure(async (turnId: string, signal: AbortSignal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            await client.turns.steer(sessionId, turnId, signal);
        }),
    };
    const queuedMessage = (commandId: string) =>
        queuedMessages(store.getState().queued, messageQueue.getState(), deliveryMessages(delivery.getState())).find(
            (message) => message.commandId === commandId,
        ) ?? null;
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };
    const sessionIdentity: SessionIdentity = {
        additionalDirectoryIds: session.entry.additionalDirectories.map((directory) => directory.directoryId),
        agentId: session.agentRef,
        directoryId: session.result.ready.directoryId,
    };
    const draftEntry = sessionDraftEntry(sessionId);

    const respondToPermission = async (response: PermissionInteractionResponse, signal: AbortSignal): Promise<void> => {
        if (client === null || store.getState().connection.kind !== "ready") {
            throw new Error("The Session is not connected.");
        }
        const reopeningsAtStart = reopenings;
        try {
            await client.interactions.respond(
                sessionId,
                response.interactionId,
                new MobiusPermissionResponseRequest("mobius-web", response.outcome, response.optionId),
                AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            );
        } catch (cause) {
            signal.throwIfAborted();
            if (closedNow(cause, reopeningsAtStart)) {
                store.getState().sessionClosed(null);
            }
            throw cause;
        }
    };
    const respondToElicitation = async (
        response: ElicitationInteractionResponse,
        signal: AbortSignal,
    ): Promise<void> => {
        if (client === null || store.getState().connection.kind !== "ready") {
            throw new Error("The Session is not connected.");
        }
        const reopeningsAtStart = reopenings;
        try {
            await client.interactions.respond(
                sessionId,
                response.interactionId,
                new MobiusElicitationResponseRequest("mobius-web", response.action, response.content),
                AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            );
        } catch (cause) {
            signal.throwIfAborted();
            if (closedNow(cause, reopeningsAtStart)) {
                store.getState().sessionClosed(null);
            }
            throw cause;
        }
    };
    const interactions = createSessionInteractionStore({
        read: async (signal) => {
            if (client === null) {
                throw new Error("The Session is not connected");
            }
            return sessionInteractionRecovery(
                await client.sessions.readSessionExecution(sessionId, sessionIdentity, signal),
            );
        },
        permission: respondToPermission,
        elicitation: respondToElicitation,
    });

    // Connection waiters are woken where the connection settles. No wrapped set, no subscriptions.
    const connectionWaiters = new Set<() => void>();
    const store = createStore<SessionPaneState>()((set, get) => {
        const operationFacts = (): SessionOperationFacts =>
            sessionOperationFacts(
                get(),
                delivery.getState(),
                tasks.getState(),
                interactions.getState(),
                options.connectionAvailable(get().connection),
            );
        let connectionChangedAt = clock.now();
        let recoveryNoticeDeadline: AbortController | null = null;
        const settleConnectionWaiters = (): void => {
            if (isConnectionSettled(get().connection)) {
                for (const wake of connectionWaiters) {
                    wake();
                }
                connectionWaiters.clear();
            }
        };
        const setAndSettle = (
            partial:
                | SessionPaneState
                | Partial<SessionPaneState>
                | ((state: SessionPaneState) => SessionPaneState | Partial<SessionPaneState>),
        ): void => {
            const previous = get().connection.kind;
            set(partial);
            const connection = get().connection;
            const current = connection.kind;
            if (
                current !== "reconnecting" &&
                (connection.kind !== "disconnected" || connection.retry.kind === "exhausted")
            ) {
                recoveryNoticeDeadline?.abort();
                recoveryNoticeDeadline = null;
            }
            if (current !== previous) {
                const now = clock.now();
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "web",
                    operation: "session-connection",
                    outcome: current,
                    elapsedMs: Math.max(0, now - connectionChangedAt),
                    requestId: "",
                });
                connectionChangedAt = now;
            }
            settleConnectionWaiters();
        };
        /** The stop control follows the running turn: a different one retires what the user asked of the previous. */
        const turnMoved = (previous: CurrentTurn, turn: CurrentTurn): void => {
            const running = acceptedTurn(turn);
            if (running?.commandId !== acceptedTurn(previous)?.commandId) {
                tasks.getState().turnChanged(running?.commandId ?? null);
            }
        };
        /** Moves the current turn by something this pane did. What the Runtime reports goes through `observeExecution`. */
        const updateTurn = (event: CurrentTurnEvent): void => {
            const previous = get().turn;
            const turn = transitionCurrentTurn(previous, event);
            if (turn === previous) {
                return;
            }
            set({ turn });
            turnMoved(previous, turn);
        };
        /**
         * Submits `commandId` through `connected`. A new turn becomes current as the service's acceptance arrives, dated
         * by when this browser sent it, or else `startedAt`; until then the turn is its delivery's.
         */
        const submitCommand =
            (
                connected: MobiusClient | null,
                commandId: string,
                target: DeliveryTarget["disposition"],
                startedAt: number,
            ): SubmitTurn =>
            async (request, signal) => {
                const accepted = await submitTurn(connected)(request, signal);
                signal.throwIfAborted();
                if (target === "reject") {
                    updateTurn({
                        kind: "accepted",
                        commandId,
                        turnId: accepted.turnId,
                        startedAt: turns.startedAt(commandId, startedAt),
                    });
                }
                return accepted;
            };
        let historyLoadController: AbortController | null = null;
        /** Adopts a new projection; its timeline is what the caller publishes. */
        const adoptProjection = (next: SessionProjection) => {
            projection = next;
            const timeline = projectedTimeline(projection);
            delivery.getState().releaseMessages(sessionUserCommandIds(timeline.messages));
            return timeline;
        };
        /**
         * Applies an execution fact the Runtime reported to everything it moves at once: the timeline, the current turn,
         * the queue, the deliveries it confirms and the pending interactions.
         */
        const observeExecution = (observation: SessionExecutionObservation): void => {
            const previous = get();
            const change = observeSessionExecution(
                { projection, turn: previous.turn, queued: previous.queued },
                observation,
                (commandId) => turns.startedAt(commandId, Date.now()),
            );
            const { execution } = change;
            set({
                ...(execution.projection === projection ? {} : adoptProjection(execution.projection)),
                queued: execution.queued,
                turn: execution.turn,
            });
            turnMoved(previous.turn, execution.turn);
            if (change.delivered.length > 0) {
                delivery.getState().reconcile(change.delivered);
                delivery.getState().releaseMessages(sessionUserCommandIds(get().messages));
            }
            if (observation.kind === "snapshot" || observation.kind === "closed" || change.leftQueue.length > 0) {
                messageQueue.getState().reconcile(execution.queued.map((message) => message.commandId));
            }
            switch (change.interactions.kind) {
                case "kept":
                    return;
                case "recovered":
                    interactions.getState().recover(change.interactions.recovery);
                    return;
                case "cleared":
                    interactions.getState().restore([]);
                    return;
                default:
                    change.interactions satisfies never;
            }
        };
        /** Reads the Runtime's execution snapshot and observes it. */
        const readExecution = async (
            connected: MobiusClient,
            turnAtRead: CurrentTurn,
            signal: AbortSignal,
            deliveryCommandId: string | null = null,
        ): Promise<void> => {
            // Only retire accepted queue inputs known before the read began. A submission accepted while this
            // snapshot was in flight may legitimately be absent from it.
            const acceptedQueue = delivery
                .getState()
                .acceptedMessages.filter((message) => message.target.disposition === "queue");
            const snapshot = await connected.sessions.readSessionExecution(
                sessionId,
                sessionIdentity,
                signal,
                deliveryCommandId ?? undefined,
            );
            signal.throwIfAborted();
            observeExecution({ kind: "snapshot", snapshot, turnAtRead, deliveryCommandId });
            delivery
                .getState()
                .releaseMessages(
                    acceptedQueue
                        .filter(
                            (message) =>
                                snapshot.turn?.commandId !== message.commandId &&
                                !snapshot.queued.some((queued) => queued.commandId === message.commandId),
                        )
                        .map((message) => message.commandId),
                );
        };
        const commitProjection = (input: SessionProjectionInput): readonly SessionProjectionEffect[] => {
            const result = transitionSessionProjection(projection, input);
            set(adoptProjection(result.state));
            for (const effect of result.effects) {
                if (effect.kind !== "adopted") {
                    continue;
                }
                if (effect.title !== undefined) {
                    titles.getState().observed(sessionId, effect.title);
                }
            }
            return result.effects;
        };
        const loadProjectionHistory = async (
            effect: Extract<SessionProjectionEffect, { readonly kind: "load-history" }>,
            connected: MobiusClient,
            parentSignal: AbortSignal,
        ): Promise<void> => {
            historyLoadController?.abort();
            const controller = new AbortController();
            historyLoadController = controller;
            const revision = projection.revision;
            const deadline = new AbortController();
            const signal = AbortSignal.any([parentSignal, controller.signal, deadline.signal]);
            void clock.sleep(45_000, signal).then(
                () => deadline.abort(new DOMException("The Session history read timed out.", "TimeoutError")),
                () => undefined,
            );
            // History read after the Runtime accepted an immediate message shows it, also where released Runtimes
            // omit its command identity there, as for a message accepted while no pane followed the Session.
            const acceptedBeforeRead = delivery
                .getState()
                .acceptedMessages.filter((message) => message.target.disposition === "reject")
                .map((message) => message.commandId);
            try {
                const history = await readSessionHistory(
                    connected,
                    sessionId,
                    null,
                    [],
                    effect.generation,
                    signal,
                    projection.kind === "established" ? projection : null,
                );
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || projection.pending === null || projection.revision !== revision) {
                    return;
                }
                const effects = commitProjection({ history, kind: "history-loaded", revision });
                delivery.getState().reconcile(sessionEventCommandIds(history.events));
                delivery.getState().releaseMessages([...sessionUserCommandIds(get().messages), ...acceptedBeforeRead]);
                if (effects.some((loaded) => loaded.kind === "read-settings")) {
                    settings
                        .getState()
                        .readInBackground(
                            (readSignal) => connected.sessions.readConfiguration(sessionId, readSignal),
                            parentSignal,
                        );
                }
            } catch (cause) {
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || projection.revision !== revision) {
                    return;
                }
                // This pane owns the history deadline. The SDK only sees an aborted
                // caller signal, so retain timeout semantics for subscription recovery.
                if (deadline.signal.aborted) {
                    throw new MobiusTimeoutError({ cause });
                }
                throw cause;
            } finally {
                deadline.abort();
                if (historyLoadController === controller) {
                    historyLoadController = null;
                }
            }
        };
        const dispatchProjection = async (
            input: SessionProjectionInput,
            connected: MobiusClient,
            signal: AbortSignal,
        ): Promise<void> => {
            const effects = commitProjection(input);
            for (const effect of effects) {
                if (effect.kind === "load-history") {
                    await loadProjectionHistory(effect, connected, signal);
                } else if (effect.kind === "read-settings") {
                    settings
                        .getState()
                        .readInBackground(
                            (readSignal) => connected.sessions.readConfiguration(sessionId, readSignal),
                            signal,
                        );
                }
            }
        };
        // Holds the connect loop on a closed Session until the user reopens it, then lets the loop connect again.
        const untilReopened = async (reason: string | null, signal: AbortSignal): Promise<void> => {
            await new Promise<void>((resolve) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                const finish = (): void => {
                    resumeAfterReopen = null;
                    signal.removeEventListener("abort", finish);
                    resolve();
                };
                resumeAfterReopen = finish;
                signal.addEventListener("abort", finish, { once: true });
                // A closed Session runs nothing: the turn, queue and interactions it was holding settle.
                observeExecution({ kind: "closed" });
                setAndSettle({ connection: { kind: "closed", reason, reopen: { kind: "available" } } });
            });
        };
        /**
         * Submits a message: the composer's draft, a failed message again, or the first message the Session's
         * delivery holds. Delivery owns that snapshot and the attempt through preparation, sending, and recovery, so
         * the attempt outlives this pane; completion never writes to the next draft.
         */
        const submit = async (message: SubmittedMessage, signal: AbortSignal): Promise<void> => {
            const currentDelivery = delivery.getState().state;
            if (!canSubmit(message.target, operationFacts())) {
                return;
            }
            const { commandId, target } = message;
            welcome.getState().dismiss();
            const sent = turns.recordSent(commandId, Date.now());
            void centralIndexedDB.set(lastSentMessageEntry, sent, signal);
            const connected = client;
            const sending = delivery.getState().send(message, {
                prepare: async ({ attachments, content }, attemptSignal) => {
                    if (connected === null) {
                        throw new Error("The Session is not connected.");
                    }
                    const uploadedAttachments =
                        attachments.kind === "uploaded"
                            ? attachments.values
                            : await uploadPromptAttachments(
                                  connected.sessions,
                                  sessionId,
                                  attachments.values,
                                  attemptSignal,
                              );
                    // Freeze semantic intent before delivery owns retries, including instructions and identity.
                    return await withInstructions(
                        connected,
                        {
                            ...request,
                            ...target,
                            agentId: session.agentRef,
                            directoryId: session.result.ready.directoryId,
                            attachments: uploadedAttachments,
                            content: content.trim(),
                        },
                        attemptSignal,
                    );
                },
                submit: submitCommand(connected, commandId, target.disposition, sent.sentAt),
            });
            // Only a message taken from the composer leaves it; a failed or first message never was in it.
            if (currentDelivery.kind === "idle") {
                centralSessionStorage.remove(draftEntry);
                composerAttachments.getState().clear();
                set({ draft: "", filesRestoreNotice: false });
            }
            if (target.disposition === "reject") {
                updateTurn({ kind: "new-turn-submitted" });
            }
            set({ followRevision: get().followRevision + 1 });
            // The retained submission owns its failure; the composer keeps the next draft.
            await sending;
            delivery.getState().releaseMessages(sessionUserCommandIds(get().messages));
        };
        return {
            connection: { kind: "first-loading" },
            titleEdit: { kind: "closed" },
            ...projectedTimeline(projection),
            olderHistory: { kind: "idle" },
            draft: centralSessionStorage.read(draftEntry) ?? "",
            filesRestoreNotice: false,
            followRevision: 0,
            operation: { kind: "idle" },
            turn: initialTurn,
            queued: [],
            loadOlderMessages: async (signal) => {
                const pagination = sessionProjectionPagination(projection);
                if (loadingOlderHistory || pagination === null || client === null) {
                    return;
                }
                loadingOlderHistory = true;
                set({ olderHistory: { kind: "loading" } });
                const reopeningsAtStart = reopenings;
                try {
                    const page = await readSessionHistory(
                        client,
                        sessionId,
                        pagination.nextCursor,
                        [],
                        pagination.generation,
                        signal,
                    );
                    signal.throwIfAborted();
                    commitProjection({ kind: "older-page", page, revision: pagination.revision });
                    set({ olderHistory: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ olderHistory: { kind: "idle" } });
                        get().sessionClosed(null);
                        return;
                    }
                    set({
                        olderHistory: {
                            kind: "failed",
                            message: formatError(cause, "Older messages could not be loaded."),
                        },
                    });
                    throw cause;
                } finally {
                    loadingOlderHistory = false;
                }
            },
            connect: async (signal) => {
                const readStoredLastSentMessage = (): void => {
                    const revision = turns.lastSentRevision();
                    void centralIndexedDB.get(lastSentMessageEntry, signal).then((stored) => {
                        if (stored === null || !turns.adoptStoredSent(stored, revision)) {
                            return;
                        }
                        updateTurn({ kind: "sent-at-known", commandId: stored.commandId, sentAt: stored.sentAt });
                    });
                };
                let consecutiveFailures = 0;
                const paneSignal = signal;
                // One grace period per interruption, shared by the bridge wait, backoff and reconciliation.
                // Successful recovery or a terminal outcome cancels it in the connection transition above.
                const recoveryNotice = (): "quiet" | "visible" => {
                    const current = get().connection;
                    if (recoveryNoticeDeadline !== null && !recoveryNoticeDeadline.signal.aborted) {
                        return current.kind === "disconnected" || current.kind === "reconnecting"
                            ? current.notice
                            : "quiet";
                    }
                    recoveryNoticeDeadline = startRecoveryNotice({
                        clock,
                        signal: paneSignal,
                        onNotice: (notice) => {
                            const connection = get().connection;
                            if (connection.kind === "disconnected" || connection.kind === "reconnecting") {
                                setAndSettle({ connection: { ...connection, notice } });
                            }
                        },
                    });
                    return "quiet";
                };
                // The signal is this attempt's own: the pane's lifetime, and also the closing of the Session.
                const observeSession = async (signal: AbortSignal): Promise<void> => {
                    client = await requests.connectSession(
                        botId,
                        sessionId,
                        signal,
                        session.result.action === "conversation" ? session.result.access : undefined,
                    );
                    const connected = client;
                    const receiveLifecycle = async (
                        fact: SessionLifecycleFact,
                        event: SessionLiveEvent,
                    ): Promise<void> => {
                        switch (fact.kind) {
                            case "interaction-requested":
                            case "permission-resolved":
                            case "elicitation-resolved":
                                await interactions.getState().apply(fact, event, signal);
                                return;
                            case "queue-changed":
                                await readExecution(connected, get().turn, signal);
                                return;
                            case "turn-started":
                                observeExecution({ kind: "turn-started", commandId: fact.commandId });
                                return;
                            case "turn-completed":
                                observeExecution({
                                    kind: "turn-ended",
                                    commandId: fact.commandId,
                                    outcome: fact.steered ? { kind: "steered" } : { kind: "completed" },
                                });
                                if (fact.steered) {
                                    // Steering ended the turn but not its execution; only a snapshot tells what runs now.
                                    await readExecution(connected, get().turn, signal);
                                }
                                return;
                            case "turn-failed":
                                observeExecution({
                                    kind: "turn-ended",
                                    commandId: fact.commandId,
                                    outcome: { kind: "failed", failure: { code: fact.code, message: fact.message } },
                                });
                                return;
                            case "none":
                                return;
                            default:
                                return fact satisfies never;
                        }
                    };
                    const observer: MobiusSessionEventObserver = {
                        reconcile: async (connection) => {
                            const reconcilingTurn = get().turn;
                            const reconciliation =
                                connection.kind === "initial"
                                    ? { kind: "initial-subscription" as const, turn: reconcilingTurn }
                                    : { kind: "reconnecting" as const, turn: reconcilingTurn };
                            switch (reconciliation.kind) {
                                case "initial-subscription":
                                    break;
                                case "reconnecting":
                                    setAndSettle({
                                        connection: {
                                            kind: "reconnecting",
                                            notice: recoveryNotice(),
                                            message: connectionFailure(get().connection),
                                        },
                                    });
                                    break;
                            }
                            await dispatchProjection({ kind: "reconcile" }, connected, signal);
                            signal.throwIfAborted();
                            // Confirm execution after history is adopted. An earlier idle snapshot
                            // cannot settle work that started while those pages were loading.
                            const submission = delivery.getState().state;
                            await readExecution(
                                connected,
                                reconciliation.turn,
                                signal,
                                submission.kind === "delivery-unknown" ? submission.journal.commandId : null,
                            );
                            switch (reconciliation.kind) {
                                case "initial-subscription":
                                    break;
                                case "reconnecting":
                                    setAndSettle({ connection: { client: connected, kind: "ready" } });
                                    break;
                            }
                        },
                        receive: async (events) => {
                            const historyLoads: Promise<void>[] = [];
                            for (const event of events) {
                                const effects = commitProjection({ event, kind: "live-event" });
                                for (const effect of effects) {
                                    if (effect.kind === "load-history") {
                                        historyLoads.push(loadProjectionHistory(effect, connected, signal));
                                    } else if (effect.kind === "read-settings") {
                                        settings
                                            .getState()
                                            .readInBackground(
                                                (readSignal) =>
                                                    connected.sessions.readConfiguration(sessionId, readSignal),
                                                signal,
                                            );
                                    }
                                }
                                if (event.type !== "acp") {
                                    await receiveLifecycle(sessionLifecycleFact(event.payload), event);
                                }
                                await new Promise<void>((resolve) => queueMicrotask(resolve));
                                signal.throwIfAborted();
                            }
                            await Promise.all(historyLoads);
                            return true;
                        },
                    };
                    const subscription = await connected.events.subscribeLive(sessionId, observer, signal);
                    signal.throwIfAborted();
                    setAndSettle({ connection: { kind: "ready", client: connected } });
                    options.onConnected();
                    const monitoring = new AbortController();
                    const monitorSignal = AbortSignal.any([signal, monitoring.signal]);
                    void (async () => {
                        try {
                            await clock.sleep(25_000, monitorSignal);
                            monitorSignal.throwIfAborted();
                            // Reset backoff only after the subscription stays open; transport
                            // heartbeats detect lost connections without polling Session execution.
                            if (get().connection.kind === "ready" && client === connected) {
                                consecutiveFailures = 0;
                            }
                        } catch {
                            // The subscription owns and cancels this monitor.
                        }
                    })();
                    try {
                        welcome.getState().connected();
                        // The first message the Session holds is submitted by the first pane that connects.
                        const awaiting = awaitingMessage(delivery.getState().state);
                        if (awaiting !== null) {
                            await submit(awaiting, paneSignal);
                            signal.throwIfAborted();
                        }
                        await subscription.completed;
                    } finally {
                        monitoring.abort();
                    }
                    signal.throwIfAborted();
                    throw sessionUpdatesEndedError();
                };
                readStoredLastSentMessage();
                for (;;) {
                    if (closure !== null) {
                        const closed = closure;
                        closure = null;
                        await untilReopened(closed.reason, signal);
                        if (signal.aborted) {
                            return;
                        }
                        consecutiveFailures = 0;
                        setAndSettle({ connection: { kind: "reconnecting", message: null, notice: recoveryNotice() } });
                    }
                    if (consecutiveFailures > 0) {
                        setAndSettle({
                            connection: {
                                kind: "reconnecting",
                                message: connectionFailure(get().connection),
                                notice: recoveryNotice(),
                            },
                        });
                    }
                    const running = new AbortController();
                    attempt = running;
                    try {
                        await observeSession(AbortSignal.any([signal, running.signal]));
                    } catch (failure) {
                        const cause = running.signal.aborted ? running.signal.reason : failure;
                        running.abort();
                        attempt = null;
                        client?.close();
                        client = null;
                        if (signal.aborted) {
                            return;
                        }
                        if (closure === null && isSessionClosedFailure(cause)) {
                            closure = { reason: null };
                        }
                        if (closure !== null) {
                            continue;
                        }
                        const retryable = isRetryableRuntimeConnectionFailure(cause);
                        if (recoveryRequested) {
                            recoveryRequested = false;
                            consecutiveFailures = 0;
                        }
                        const retry = retryable
                            ? sessionReconnectAttempt(consecutiveFailures)
                            : { kind: "exhausted" as const };
                        consecutiveFailures += 1;
                        recordBrowserDiagnostic({
                            at: new Date().toISOString(),
                            component: "web",
                            operation: "session-interruption",
                            outcome: cause instanceof MobiusError ? cause.code : "bridge_unavailable",
                            attempt: consecutiveFailures,
                            elapsedMs: 0,
                            requestId: "",
                        });
                        const message = formatError(cause, "The Session could not be opened.");
                        setAndSettle({
                            connection: retryable
                                ? disconnectedConnection(
                                      message,
                                      retry.kind === "scheduled" ? retry.delayMs : null,
                                      recoveryNotice(),
                                  )
                                : { kind: "failed", message },
                        });
                        countdownInterrupt = new AbortController();
                        const retrySignal = AbortSignal.any([signal, countdownInterrupt.signal]);
                        try {
                            if (isChatBridgeError(cause)) {
                                // The bridge owns its dial/backoff. Do not spend a
                                // second retry budget waiting for that dependency.
                                setAndSettle({
                                    connection: {
                                        kind: "disconnected",
                                        message,
                                        retry: { kind: "waiting-for-bridge" },
                                        notice: recoveryNotice(),
                                    },
                                });
                                await requests.waitForBridge(retrySignal);
                                consecutiveFailures = 0;
                            } else if (retry.kind === "scheduled") {
                                const retryAt = clock.now() + retry.delayMs;
                                while (clock.now() < retryAt) {
                                    await clock.sleep(Math.min(1000, retryAt - clock.now()), retrySignal);
                                    retrySignal.throwIfAborted();
                                    setAndSettle({
                                        connection: disconnectedConnection(
                                            message,
                                            retryAt - clock.now(),
                                            recoveryNotice(),
                                        ),
                                    });
                                }
                            } else {
                                if (retryable) {
                                    // The automatic retries are used up: the owner retries once it sees the Runtime
                                    // reachable again, and the user can retry at any time.
                                    options.onWaitingForRuntime();
                                }
                                await new Promise<void>((resolve) => {
                                    if (retrySignal.aborted) {
                                        resolve();
                                        return;
                                    }
                                    retrySignal.addEventListener("abort", () => resolve(), { once: true });
                                });
                            }
                        } catch (cause) {
                            if (!retrySignal.aborted) {
                                throw cause;
                            }
                        }
                        countdownInterrupt = null;
                        if (signal.aborted) {
                            return;
                        }
                    }
                }
            },
            recover: async (parent) => {
                parent.throwIfAborted();
                const state = get().connection;
                if (state.kind === "disconnected") {
                    // A foreground hint can expedite recovery without replenishing
                    // every short-lived connection's retry budget.
                    if (state.retry.kind === "exhausted") {
                        recoveryRequested = true;
                    }
                    void requests.recoverBridge(parent).catch(() => undefined);
                    countdownInterrupt?.abort(new Error("The browser resumed."));
                    return;
                }
            },
            retryNow: () => {
                recoveryRequested = true;
                void requests.recoverBridge(lifetime.signal).catch(() => undefined);
                countdownInterrupt?.abort(new Error("Retried now"));
            },
            sessionClosed: (reason) => {
                const current = get().connection;
                // A failed operation and the Runtime's notice can both report one closing; the notice has the reason.
                if (current.kind === "closed") {
                    if (current.reason === null && reason !== null) {
                        set({ connection: { ...current, reason } });
                    }
                    return;
                }
                if (closure !== null) {
                    if (closure.reason === null && reason !== null) {
                        closure = { reason };
                    }
                    return;
                }
                closure = { reason };
                // The connect loop takes over: it stops the running attempt or retry countdown and shows the closing.
                attempt?.abort(new Error("The Session closed."));
                countdownInterrupt?.abort(new Error("The Session closed."));
            },
            reopen: async (signal) => {
                const current = get().connection;
                if (current.kind !== "closed" || current.reopen.kind === "reopening" || resumeAfterReopen === null) {
                    return;
                }
                const setReopen = (reopen: Extract<SessionConnection, { readonly kind: "closed" }>["reopen"]): void => {
                    const connection = get().connection;
                    if (connection.kind === "closed") {
                        set({ connection: { ...connection, reopen } });
                    }
                };
                setReopen({ kind: "reopening" });
                try {
                    await requests.managedSession(botId, sessionId, signal);
                    signal.throwIfAborted();
                } catch (cause) {
                    signal.throwIfAborted();
                    setReopen({ kind: "failed", message: formatError(cause, "The Session could not be reopened.") });
                    return;
                }
                // Failures the closing caused say nothing about the reopened Session.
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                reopenings += 1;
                resumeAfterReopen?.();
            },
            setDraft: (draft) => {
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                if (draft === "") {
                    centralSessionStorage.remove(draftEntry);
                } else {
                    centralSessionStorage.write(draftEntry, draft);
                }
                set(draft === "" ? { draft, filesRestoreNotice: false } : { draft });
            },
            send: async (signal) => {
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const draft = get().draft;
                if (
                    !composerHasMessage(draft, attachments.length, attachmentState.kind === "reading") ||
                    !canSendNow(operationFacts())
                ) {
                    return;
                }
                await submit(
                    {
                        commandId: crypto.randomUUID(),
                        content: draft,
                        attachments: { kind: "local", values: attachments },
                        target: { disposition: "reject", targetCommandId: "" },
                    },
                    signal,
                );
            },
            removeUnknownDelivery: () => {
                delivery.getState().discardUnknown();
            },
            retryUnknownDelivery: async () => {
                const state = delivery.getState().state;
                if (
                    state.kind !== "delivery-unknown" ||
                    !canRetryUnknownDelivery(journalMessage(state.journal).target, operationFacts())
                ) {
                    return;
                }
                const pending = state.journal;
                if (pending.request.disposition === "reject") {
                    updateTurn({ kind: "new-turn-submitted" });
                }
                // Without a record of when this browser sent it, the retry dates the command's work.
                const retrying = submitCommand(client, pending.commandId, pending.request.disposition, Date.now());
                await delivery.getState().retry(retrying);
                delivery.getState().releaseMessages(sessionUserCommandIds(get().messages));
            },
            retryFailedMessage: async (signal) => {
                const state = delivery.getState().state;
                const message =
                    state.kind === "preparation-failed"
                        ? // Nothing reached the Runtime, so the message keeps its identity.
                          state.message
                        : state.kind === "failed"
                          ? // The Runtime definitively rejected this identity and will not run it again.
                            { ...journalMessage(state.journal), commandId: crypto.randomUUID() }
                          : null;
                if (message === null || !canRetryFailedMessage(message.target, operationFacts())) {
                    return;
                }
                await submit(message, signal);
            },
            editFailedMessage: () => {
                if (composerAttachments.getState().state.kind === "reading") {
                    return;
                }
                const message = delivery.getState().takeFailedMessage();
                if (message === null) {
                    return;
                }
                get().setDraft(prependToDraft(message.content, get().draft));
                if (message.attachments.kind === "local") {
                    composerAttachments
                        .getState()
                        .restore([...message.attachments.values, ...composerAttachments.getState().attachments]);
                } else if (message.attachments.values.length > 0) {
                    set({ filesRestoreNotice: true });
                }
            },
            discardFailedMessage: () => {
                delivery.getState().takeFailedMessage();
            },
            queueDraft: async (signal) => {
                const current = get();
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const running = acceptedTurn(current.turn);
                if (
                    running === null ||
                    !composerHasMessage(current.draft, attachments.length, attachmentState.kind === "reading") ||
                    !canQueue(operationFacts())
                ) {
                    return;
                }
                await submit(
                    {
                        commandId: crypto.randomUUID(),
                        content: current.draft,
                        attachments: { kind: "local", values: attachments },
                        target: { disposition: "queue", targetCommandId: running.commandId },
                    },
                    signal,
                );
            },
            steerQueued: async (commandId, signal) => {
                const steered = await messageQueue
                    .getState()
                    .steerMessage(queuedMessage(commandId), queuePort.steer, signal);
                signal.throwIfAborted();
                if (steered !== null) {
                    set({ followRevision: get().followRevision + 1 });
                }
            },
            deleteQueued: async (commandId, signal) => {
                const removed = await messageQueue
                    .getState()
                    .deleteMessage(queuedMessage(commandId), queuePort.cancel, signal);
                signal.throwIfAborted();
                if (removed !== null) {
                    delivery.getState().releaseMessages([removed.commandId]);
                }
            },
            editQueued: async (commandId, signal) => {
                const removed = await messageQueue
                    .getState()
                    .deleteMessage(queuedMessage(commandId), queuePort.cancel, signal);
                signal.throwIfAborted();
                if (removed === null) {
                    return;
                }
                delivery.getState().releaseMessages([removed.commandId]);
                // The queued message was written first, so it goes ahead of a draft the user started since.
                const current = get().draft;
                get().setDraft(
                    current.trim() === ""
                        ? removed.prompt
                        : removed.prompt === ""
                          ? current
                          : `${removed.prompt}\n\n${current}`,
                );
                const restored: readonly ComposerAttachment[] =
                    removed.attachments.kind === "restorable" ? removed.attachments.values : [];
                composerAttachments.getState().restore([...restored, ...composerAttachments.getState().attachments]);
                set({
                    filesRestoreNotice: removed.attachments.kind === "unrestorable" && removed.attachments.count > 0,
                });
            },
            configure: async (option, value, booleanValue, signal) => {
                if (client === null || !canChangeSettings(operationFacts())) {
                    return;
                }
                const connected = client;
                set({ operation: { configId: option.id, kind: "configuring" } });
                const reopeningsAtStart = reopenings;
                try {
                    const result = await client.sessions.updateConfiguration(
                        sessionId,
                        {
                            additionalDirectoryIds: session.entry.additionalDirectories.map(
                                (directory) => directory.directoryId,
                            ),
                            agentId: session.agentRef,
                            booleanValue,
                            configId: option.id,
                            expectedConfigurationRevision: settings.getState().configurationRevision,
                            directoryId: session.result.ready.directoryId,
                            value,
                            valueType: option.type,
                        },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    settings.getState().adopt(result);
                    set({ operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ operation: { kind: "idle" } });
                        get().sessionClosed(null);
                        return;
                    }
                    if (cause instanceof MobiusApiError && cause.code === "session_configuration_conflict") {
                        settings
                            .getState()
                            .readInBackground(
                                (readSignal) => connected.sessions.readConfiguration(sessionId, readSignal),
                                signal,
                            );
                    }
                    set({
                        operation: {
                            kind: "failed",
                            message: formatError(cause, "The selection could not be applied."),
                        },
                    });
                }
            },
            openTitleEdit: () => {
                set({ titleEdit: { draft: sessionTitle(titles.getState().titles, sessionId), kind: "editing" } });
            },
            setTitleDraft: (draft) => {
                if (get().titleEdit.kind === "editing") {
                    set({ titleEdit: { draft, kind: "editing" } });
                }
            },
            cancelTitleEdit: () => {
                set({ titleEdit: { kind: "closed" } });
            },
            confirmTitleEdit: async (signal) => {
                const edit = get().titleEdit;
                if (edit.kind !== "editing") {
                    return;
                }
                const trimmed = edit.draft.trim();
                if (
                    trimmed.length === 0 ||
                    trimmed === sessionTitle(titles.getState().titles, sessionId) ||
                    client === null ||
                    get().connection.kind !== "ready"
                ) {
                    set({ titleEdit: { kind: "closed" } });
                    return;
                }
                set({ titleEdit: { draft: trimmed, kind: "saving" } });
                const reopeningsAtStart = reopenings;
                try {
                    const result = await client.sessions.rename(
                        sessionId,
                        trimmed,
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    titles.getState().observed(sessionId, result.title);
                    set({ titleEdit: { kind: "closed" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ titleEdit: { kind: "closed" } });
                        get().sessionClosed(null);
                        return;
                    }
                    set({
                        titleEdit: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The conversation could not be renamed.",
                        },
                    });
                }
            },
            stop: async (signal) => await tasks.getState().stop(signal),
        };
    });
    const welcome = createSessionWelcomeStore({
        botId,
        sessionId,
        fillEmptyDraft: (text) => {
            const presentation = sessionPanePresentation(
                store.getState(),
                delivery.getState(),
                tasks.getState(),
                messageQueue.getState(),
                composerAttachments.getState(),
                interactions.getState(),
                options.connectionAvailable(store.getState().connection),
            );
            if (!presentation.canSuggestProgress) {
                return false;
            }
            store.getState().setDraft(text);
            return true;
        },
    });
    const waitForConnectionReady = async (signal: AbortSignal): Promise<void> => {
        while (true) {
            signal.throwIfAborted();
            const current = store.getState().connection;
            if (current.kind === "ready") {
                return;
            }
            if (current.kind === "failed" || (current.kind === "disconnected" && current.retry.kind === "exhausted")) {
                throw new MobiusError("session_not_connected", current.message);
            }
            if (current.kind === "closed") {
                throw new MobiusError(SESSION_CLOSED_ERROR_CODE, "The session is closed.");
            }
            await new Promise<void>((resolve, reject) => {
                const wake = (): void => {
                    cleanup();
                    resolve();
                };
                const abort = (): void => {
                    cleanup();
                    reject(signal.reason);
                };
                const cleanup = (): void => {
                    connectionWaiters.delete(wake);
                    signal.removeEventListener("abort", abort);
                };
                connectionWaiters.add(wake);
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    };
    const readFile = async (path: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const current = store.getState().connection;
        if (current.kind !== "ready") {
            throw new MobiusError("session_not_connected", "The Session is not connected.");
        }
        return await current.client.sessions.readFile(
            sessionId,
            path,
            AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(20_000)]),
            32 * 1024 * 1024,
        );
    };
    const readResource = async (path: string, signal: AbortSignal) => {
        // The same bounded lifetime covers connection recovery and the file read.
        const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(20_000)]);
        await waitForConnectionReady(requestSignal);
        return await readFile(path, requestSignal);
    };
    const filePreview = createBrowserFilePreviewStore(readFile);
    /**
     * Starts the pane's Session connection. The owner that created the pane starts it once; the connection then
     * follows the Session, its interruptions and its closing until the owner stops the pane.
     */
    const start = (): void => {
        if (phase !== "created") {
            return;
        }
        phase = "started";
        const unregisterDebug = registerMortyDebugSession({
            sessionId,
            blocks: () => sessionDebugBlocks(store.getState()),
        });
        lifetime.signal.addEventListener("abort", unregisterDebug, { once: true });
        void store
            .getState()
            .connect(lifetime.signal)
            .catch((cause: unknown) => {
                if (!lifetime.signal.aborted) {
                    reportApplicationError(cause, "session-pane-connect");
                }
            });
    };
    /**
     * Starts the next attempt of a connection that used up its automatic retries, without restoring them: the owner
     * calls it when it sees the Runtime reachable again, and a failed attempt waits for the owner's next call.
     */
    const reconnect = (): void => {
        if (connectionWaitsForRuntime(store.getState().connection)) {
            countdownInterrupt?.abort(new Error("The Runtime is reachable again."));
        }
    };
    /**
     * Ends the pane: its connection and everything bound to its lifetime. The owner stops a pane it replaces or
     * removes; a stopped pane is never restarted. Idempotent.
     */
    const stop = (): void => {
        if (phase === "stopped") {
            return;
        }
        phase = "stopped";
        filePreview.getState().close();
        lifetime.abort(new Error("The session pane stopped."));
        messageQueue.getState().interrupted();
        options.onReleased?.(sessionActivity(store.getState().turn, delivery.getState().state));
    };
    // Views read the pane's state and invoke the user's actions; the connection loop stays with `start`.
    const paneStore: StoreApi<SessionPaneStore> = store;
    return {
        composerAttachments,
        attachmentSignal: options.attachmentSignal,
        interactions,
        settings,
        store: paneStore,
        delivery,
        filePreview,
        messageQueue,
        tasks,
        welcome,
        /** The Bot this pane talks to; scopes failure approvals. */
        botId,
        /** The agent the session runs on; the harness lock offers it. */
        agentRef: session.agentRef,
        /** The opened session record; scopes the execution context. */
        session,
        start,
        stop,
        reconnect,
        /** The signal for view-triggered operations: the pane's lifetime. */
        operationsSignal: () => lifetime.signal,
        readResource,
    };
}
