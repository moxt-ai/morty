import {
    type MortyClient,
    MortyError,
    MortyPageRequest,
    type MortySessionEventObserver,
    MortyTimeoutError,
    type PromptAttachment,
    type SessionConfigOption,
} from "@morty-build/client";
import type { SessionEvent, SessionLiveEvent } from "@morty-build/client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { registerMortyDebugSession } from "../../debug-bridge.ts";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastHarnessPreference } from "../../services/chat/last-harness-preference.ts";
import { recordBrowserDiagnostic } from "../../services/diagnostics/browser-diagnostics.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableRuntimeConnectionFailure, isSessionClosedFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import { agentQuestionAnswer, openAgentQuestions } from "./agent-question-answer.ts";
import type { ComposerAttachmentStore } from "./composer-attachment-store.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import { uploadPromptAttachment, uploadPromptAttachments } from "./prompt-attachment-upload.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";
import { type SessionActivityState, workingCommandId } from "./session-activity-machine.ts";
import type { SessionComposerStore } from "./session-composer-store.ts";
import {
    connectionFailure,
    connectionReadiness,
    connectionWaitsForRuntime,
    disconnectedConnection,
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
    ownerRunsTurn,
    sessionActivity,
    transitionCurrentTurn,
    workingIndicator,
} from "./session-current-turn.ts";
import { sessionDebugBlocks } from "./session-debug-blocks.ts";
import { sessionDeliveryPresentation } from "./session-delivery-presentation.ts";
import {
    awaitingMessage,
    type DeliveryPlacement,
    deliveryMessages,
    journalMessage,
    type RuntimeCommandFacts,
    type SessionDeliveryStore,
    type SubmitTurn,
    type SubmittedMessage,
} from "./session-delivery-store.ts";
import {
    observeSessionExecution,
    type QueuedCommand,
    type SessionExecutionObservation,
    type SessionExecutionSnapshot,
} from "./session-execution.ts";
import type { SessionInteractionStore } from "./session-interaction-store.ts";
import { type SessionLifecycleFact, sessionInteractionRecovery, sessionLifecycleFact } from "./session-lifecycle.ts";
import {
    type ChatQueuedMessage,
    queuedMessages,
    type SessionMessageQueueStore,
} from "./session-message-queue-store.ts";
import type { SessionConnectionFollower } from "./session-operation-connection.ts";
import {
    canChangeSettings,
    canRetryFailedMessage,
    canRetryUnknownDelivery,
    canSend,
    canSubmit,
    composerHasMessage,
    type SessionOperationFacts,
} from "./session-operation-rules.ts";
import type { SessionPageState } from "./session-page-state.ts";
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
    sessionProjectionOlderHistory,
    sessionProjectionPagination,
    sessionProjectionTimeline,
    transitionSessionProjection,
} from "./session-projection.ts";
import type { SessionRename, SessionRenameStore } from "./session-rename-store.ts";
import type { SessionSettingsStore } from "./session-settings-store.ts";
import { type SessionTaskControlsStore, stopFailure, stopRequested } from "./session-task-controls.ts";
import { type SessionTitlesStore, sessionTitle } from "./session-titles-store.ts";
import { createSessionWelcomeStore } from "./session-welcome-store.ts";

/**
 * What views see of a pane: its stores and the user's actions. Starting, stopping and reconnecting the pane is its
 * owner's.
 */
export type SessionPaneModel = Omit<ReturnType<typeof createSessionPaneModel>, "start" | "stop" | "reconnect">;

/** Renaming the Session. A failed rename closes the editor and keeps its failure until the next edit. */
export type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string }
    | { readonly kind: "failed"; readonly message: string };

/** What the title editor shows: the draft being edited in this pane, otherwise the rename the Session holds. */
export function sessionTitleEdit(draft: string | null, rename: SessionRename): TitleEdit {
    if (draft !== null) {
        return { kind: "editing", draft };
    }
    switch (rename.kind) {
        case "none":
            return { kind: "closed" };
        case "pending":
            return { kind: "saving", draft: rename.title };
        case "failed":
            return { kind: "failed", message: rename.message };
        default:
            return rename satisfies never;
    }
}

export type { SessionConnection } from "./session-connection.ts";

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
export interface SessionPaneStore {
    readonly connection: SessionConnection;
    /**
     * The Session's history as this connection follows it, the only source of the timeline. Its messages, older
     * history and revision are read through `sessionProjectionTimeline`.
     */
    readonly projection: SessionProjection;
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
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
    /**
     * Loads the page of history before the oldest message shown. The load runs on the pane's lifetime: `signal` only
     * ends the caller's wait for it.
     */
    readonly loadOlderMessages: (signal: AbortSignal) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly send: () => Promise<void>;
    /** Picks a suggested answer to a question the user can still answer. */
    readonly chooseAnswer: (messageId: string, questionIndex: number, answer: string) => void;
    /**
     * Answers the questions a message asks with the picked answers, as a message of its own sent the way the
     * composer sends it. The composer's draft stays as it is.
     */
    readonly sendAnswer: (messageId: string) => Promise<void>;
    readonly removeUnknownDelivery: () => void;
    /** Retries on the Session's delivery: the attempt may outlive this pane. */
    readonly retryUnknownDelivery: () => Promise<void>;
    readonly retryFailedMessage: () => Promise<void>;
    readonly editFailedMessage: () => void;
    readonly discardFailedMessage: () => void;
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

/**
 * Where a submitted message comes from: the composer's draft, an answer to a question an Agent message asks, or a
 * message delivery already holds (the Session's first message, or a failed one sent again).
 */
type SubmissionSource = "composer" | "answer" | "held";

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
    model: Pick<SessionPaneStore, "connection" | "turn">,
    delivery: Pick<SessionDeliveryStore, "state">,
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    interactions: Pick<SessionInteractionStore, "interactions">,
    settings: Pick<SessionSettingsStore, "change">,
    connectionAvailable: boolean,
): SessionOperationFacts {
    return {
        connectionAvailable,
        connection: model.connection.kind,
        stopping: stopRequested(tasks, acceptedTurn(model.turn)),
        configuring: settings.change.kind === "configuring",
        delivery: delivery.state.kind,
        waitingForInput: waitingForInput(interactions),
    };
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    composer: Pick<SessionComposerStore, "draft" | "titleDraft">,
    rename: SessionRenameStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
    attachments: ComposerAttachmentStore,
    interactions: SessionInteractionStore,
    settings: Pick<SessionSettingsStore, "change">,
    connectionAvailable: boolean,
) {
    const facts = sessionOperationFacts(model, delivery, tasks, interactions, settings, connectionAvailable);
    const timeline = sessionProjectionTimeline(model.projection);
    const olderHistory = sessionProjectionOlderHistory(model.projection);
    const activity = sessionActivity(model.turn, delivery.state);
    // Which turn runs is the current turn's; the stop control only adds whether the user asked to stop it.
    const controlRunning = acceptedTurn(model.turn) !== null;
    const stopping = facts.stopping;
    const composerInputDisabled =
        model.connection.kind === "closed" || facts.configuring || facts.waitingForInput || stopping;
    const activeCommandId = workingCommandId(activity);
    const activeMessageId =
        activeCommandId !== null
            ? (timeline.messages.findLast((message) => message.role === "assistant")?.firstEvent.eventId ?? null)
            : null;
    const unknownDelivery = delivery.state.kind === "delivery-unknown" ? journalMessage(delivery.state.journal) : null;
    const deliveryUnknownCommandId = unknownDelivery?.commandId ?? null;
    const deliveryUnknownUserMessageId = deliveryUnknownCommandId === null ? null : deliveryUnknownCommandId;
    const deliveries = sessionDeliveryPresentation(timeline.messages, model.queued, delivery, queue);
    const pendingMessage = deliveries.pendingDelivery?.message ?? null;
    const pendingDelivery = deliveries.pendingDelivery;
    const hasFailureCard =
        activity.kind === "failed" &&
        timeline.messages.some(
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
        settingsStopDisabled:
            !connectionAvailable || model.connection.kind !== "ready" || stopping || ownerRunsTurn(model.turn),
        stopDisabled: !connectionAvailable || model.connection.kind !== "ready" || ownerRunsTurn(model.turn),
        canSuggestProgress:
            !controlRunning &&
            canSend(facts) &&
            composer.draft.length === 0 &&
            attachments.attachments.length === 0 &&
            attachments.state.kind !== "reading",
        // Operations that failed because the Session closed say nothing the closed notice does not already say.
        composerError:
            model.connection.kind === "closed" || pendingDelivery?.error != null
                ? ""
                : ([
                      activity,
                      sessionTitleEdit(composer.titleDraft, rename.rename),
                      olderHistory,
                      settings.change,
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
        hasOlderHistory: timeline.hasOlderHistory,
        historyLoading: olderHistory.kind === "loading",
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
        workingIndicator: workingIndicator(model.turn, facts.waitingForInput),
        retryFailedDisabled: pendingMessage === null || !canRetryFailedMessage(facts),
        retryUnknownDeliveryDisabled: unknownDelivery === null || !canRetryUnknownDelivery(facts),
        submitDisabled:
            !composerHasMessage(composer.draft, attachments.attachments.length, attachments.state.kind === "reading") ||
            !canSend(facts),
        // An answer to an Agent's question goes out as the composer's message would, whatever the draft holds.
        answerDisabled: !canSend(facts),
        ...deliveries,
    } as const;
}

interface SessionIdentity {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
}

async function readSessionHistory(
    client: MortyClient,
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
            new MortyPageRequest(SESSION_EVENT_PAGE_LIMIT, requestedCursor ?? ""),
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

/** The history a projection already shows, which a reload reads at least back to. */
function loadedRange(
    projection: SessionProjection,
): Extract<SessionProjection, { readonly kind: "established" }> | null {
    return projection.kind === "established" ? projection : null;
}

/** Waits for `work` until it settles or `signal` ends the wait; the work itself goes on. */
async function untilSettledOrAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
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
    readonly session: SelectedMortySession;
    /** What the page holds for the Session, which outlives this pane. */
    readonly sessionPage: SessionPageState;
    readonly attachmentSignal: AbortSignal;
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
    const { session, botId, requests, clock, titles } = options;
    const { composer, delivery, interactions, queue: messageQueue, rename, settings, tasks } = options.sessionPage;
    const composerAttachments = composer.getState().attachments;
    const sessionId = session.result.ready.sessionId;
    // Working in a conversation makes its harness the reference for the next draft. Its settings carry into New
    // Session only where the user changes them: the others are the Agent's and its directory's, which the draft reads
    // for itself.
    saveLastHarnessPreference(botId, session.agentRef);
    const fallbackStartedAt = Date.now();
    const initialTurn: CurrentTurn =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? openedTurn({
                  commandId: session.result.activeTurn.commandId,
                  turnId: session.result.activeTurn.turnId,
                  startedAt: fallbackStartedAt,
              })
            : idleTurn;
    let client: MortyClient | null = null;
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
    // This pane's lending of its connection to the Session's operations, from `start` until `stop`.
    let follower: SessionConnectionFollower | null = null;
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
    const instructionUri = "morty://bot/instructions";
    const withInstructions = async <T extends { readonly attachments: readonly PromptAttachment[] }>(
        connected: MortyClient,
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
    const submitTurn = (connected: MortyClient | null): SubmitTurn =>
        noticingClosure(async (request, signal) => {
            if (connected === null) {
                throw new Error("The Session is not connected.");
            }
            const turn = await connected.turns.submit(sessionId, request, signal);
            return { turnId: turn.turnId, queued: turn.state.kind === "queued" };
        });
    /** The messages the timeline shows now. */
    const timelineMessages = (): readonly SessionExecutionMessage[] =>
        sessionProjectionTimeline(store.getState().projection).messages;
    const queuedMessage = (commandId: string): ChatQueuedMessage | null =>
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
    /**
     * Lends the Session's operations this pane's connection as it is now. A failure an operation meets through it
     * closes this pane when it says the Session is closed now, not as it was before a reopening since the lending.
     */
    const lendConnection = (connection: SessionConnection): void => {
        const reopeningsAtLending = reopenings;
        follower?.changed(connectionReadiness(connection), (cause) => {
            if (closedNow(cause, reopeningsAtLending)) {
                store.getState().sessionClosed(null);
            }
        });
    };

    const store = createStore<SessionPaneState>()((set, get) => {
        const operationFacts = (): SessionOperationFacts =>
            sessionOperationFacts(
                get(),
                delivery.getState(),
                tasks.getState(),
                interactions.getState(),
                settings.getState(),
                options.connectionAvailable(get().connection),
            );
        let connectionChangedAt = clock.now();
        let recoveryNoticeDeadline: AbortController | null = null;
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
            lendConnection(connection);
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
         * Submits `commandId` through `connected`. A message the Runtime runs at once becomes the current turn as the
         * service's acceptance arrives, dated by `startedAt`, when this browser sent it, until the Runtime reports its
         * start; until then the turn is its delivery's. A message the Runtime queued starts no turn yet.
         */
        const submitCommand =
            (connected: MortyClient | null, commandId: string, startedAt: number): SubmitTurn =>
            async (request, signal) => {
                const accepted = await submitTurn(connected)(request, signal);
                signal.throwIfAborted();
                if (!accepted.queued) {
                    updateTurn({
                        kind: "accepted",
                        commandId,
                        turnId: accepted.turnId,
                        startedAt,
                    });
                }
                return accepted;
            };
        let historyLoadController: AbortController | null = null;
        /**
         * Tells the Session's delivery what the Runtime has now shown about its commands, from the timeline, the
         * current turn and the queue this pane holds. The evidence adds what the observation itself shows: commands it
         * confirms, and the queue read it came from with the acceptances that read covers. Delivery learns of the
         * Runtime only here.
         */
        const deliveryObserved = (evidence: {
            readonly delivered?: readonly string[];
            readonly listing?: RuntimeCommandFacts["listing"];
        }): void => {
            const { delivered = [], listing = null } = evidence;
            const { projection, queued, turn } = get();
            const shown = new Set(sessionUserCommandIds(sessionProjectionTimeline(projection).messages));
            const running = acceptedTurn(turn)?.commandId ?? null;
            delivery.getState().observe({
                known: new Set([
                    ...delivered,
                    ...shown,
                    ...queued.map((message) => message.commandId),
                    ...(running === null ? [] : [running]),
                ]),
                shown,
                running,
                listing,
            });
        };
        /**
         * Applies an execution fact the Runtime reported to everything it moves at once: the timeline, the current turn,
         * the queue, the deliveries it confirms and the pending interactions.
         */
        const observeExecution = (
            observation: SessionExecutionObservation,
            listing: RuntimeCommandFacts["listing"] = null,
        ): void => {
            const previous = get();
            const change = observeSessionExecution(
                { projection: previous.projection, turn: previous.turn, queued: previous.queued },
                observation,
            );
            const { execution } = change;
            set({ projection: execution.projection, queued: execution.queued, turn: execution.turn });
            turnMoved(previous.turn, execution.turn);
            deliveryObserved({ delivered: change.delivered, listing });
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
        let executionPosition: SessionExecutionSnapshot["executionPosition"];
        /** Reads the Runtime's execution snapshot, observes it and returns it. */
        const readExecution = async (
            connected: MortyClient,
            turnAtRead: CurrentTurn,
            signal: AbortSignal,
            deliveryCommandId: string | null = null,
        ): Promise<SessionExecutionSnapshot> => {
            // The read lists only messages accepted before it began; one accepted while it is in flight may be missing.
            const acceptedBefore = delivery.getState().acceptances;
            const snapshot = await connected.sessions.readSessionExecution(
                sessionId,
                sessionIdentity,
                signal,
                deliveryCommandId ?? undefined,
            );
            signal.throwIfAborted();
            if (
                snapshot.executionPosition !== undefined &&
                executionPosition !== undefined &&
                snapshot.executionPosition.sessionGenerationId === executionPosition.sessionGenerationId &&
                BigInt(snapshot.executionPosition.throughPosition) < BigInt(executionPosition.throughPosition)
            ) {
                return snapshot;
            }
            executionPosition = snapshot.executionPosition;
            observeExecution(
                { kind: "snapshot", snapshot, turnAtRead, deliveryCommandId, readAt: Date.now() },
                { queued: new Set(snapshot.queued.map((queued) => queued.commandId)), acceptedBefore },
            );
            return snapshot;
        };
        /** Moves the projection by `input`, and tells delivery what the moved timeline shows of the Runtime. */
        const commitProjection = (
            input: SessionProjectionInput,
            evidence: Parameters<typeof deliveryObserved>[0] = {},
        ): readonly SessionProjectionEffect[] => {
            const result = transitionSessionProjection(get().projection, input);
            if (result.state !== get().projection) {
                set({ projection: result.state });
                deliveryObserved(evidence);
            }
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
            connected: MortyClient,
            parentSignal: AbortSignal,
        ): Promise<void> => {
            historyLoadController?.abort();
            const controller = new AbortController();
            historyLoadController = controller;
            const revision = get().projection.revision;
            const deadline = new AbortController();
            const signal = AbortSignal.any([parentSignal, controller.signal, deadline.signal]);
            void clock.sleep(45_000, signal).then(
                () => deadline.abort(new DOMException("The Session history read timed out.", "TimeoutError")),
                () => undefined,
            );
            try {
                const history = await readSessionHistory(
                    connected,
                    sessionId,
                    null,
                    [],
                    effect.generation,
                    signal,
                    loadedRange(get().projection),
                );
                parentSignal.throwIfAborted();
                const current = get().projection;
                if (controller.signal.aborted || current.pending === null || current.revision !== revision) {
                    return;
                }
                const effects = commitProjection(
                    { history, kind: "history-loaded", revision },
                    { delivered: sessionEventCommandIds(history.events) },
                );
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
                if (controller.signal.aborted || get().projection.revision !== revision) {
                    return;
                }
                // This pane owns the history deadline. The SDK only sees an aborted
                // caller signal, so retain timeout semantics for subscription recovery.
                if (deadline.signal.aborted) {
                    throw new MortyTimeoutError({ cause });
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
            connected: MortyClient,
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
         * Submits a message: the composer's draft, an answer to an Agent's question, a failed message again, or the
         * first message the Session's delivery holds. Delivery owns that snapshot and the attempt through
         * preparation, sending, and recovery, so the attempt outlives this pane; completion never writes to the next
         * draft.
         */
        const submit = async (
            submitted: Omit<SubmittedMessage, "placement">,
            source: SubmissionSource,
        ): Promise<void> => {
            if (!canSubmit(operationFacts())) {
                return;
            }
            // Shown in the queue while a turn runs, otherwise as the next turn, until the Runtime says which it is.
            const placement: DeliveryPlacement = get().turn.kind === "current" ? "queue" : "turn";
            const message: SubmittedMessage = { ...submitted, placement };
            const { commandId } = message;
            welcome.getState().dismiss();
            const sentAt = Date.now();
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
                            agentId: session.agentRef,
                            directoryId: session.result.ready.directoryId,
                            attachments: uploadedAttachments,
                            content: content.trim(),
                        },
                        attemptSignal,
                    );
                },
                submit: submitCommand(connected, commandId, sentAt),
            });
            // Only a message taken from the composer leaves it.
            if (source === "composer") {
                composer.getState().sent();
            }
            if (placement === "turn") {
                updateTurn({ kind: "new-turn-submitted" });
            }
            set({ followRevision: get().followRevision + 1 });
            // The retained submission owns its failure; the composer keeps the next draft.
            await sending;
            // The Runtime's account may already show the accepted message.
            deliveryObserved({});
        };
        /** The message that answers a still open question message with the answers picked for it, if they are complete. */
        const pickedAnswer = (messageId: string): string | null => {
            const questions = openAgentQuestions(timelineMessages()).get(messageId);
            return questions === undefined
                ? null
                : agentQuestionAnswer(questions, composer.getState().answerChoices.get(messageId) ?? {});
        };
        /** Sends a message the user wrote, which the Runtime runs now or queues behind the Session's earlier work. */
        const sendMessage = async (
            content: string,
            attachments: readonly ComposerAttachment[],
            source: SubmissionSource,
        ): Promise<void> => {
            if (!canSend(operationFacts())) {
                return;
            }
            await submit(
                {
                    commandId: crypto.randomUUID(),
                    content,
                    attachments: { kind: "local", values: attachments },
                },
                source,
            );
        };
        /** The load of the page before the oldest message shown that runs now, which every caller waits on. */
        let olderHistoryLoad: Promise<void> | null = null;
        const loadOlderHistory = async (): Promise<void> => {
            const pagination = sessionProjectionPagination(get().projection);
            if (pagination === null || client === null) {
                return;
            }
            const connected = client;
            const { revision } = pagination;
            commitProjection({ kind: "older-page-requested", revision });
            const reopeningsAtStart = reopenings;
            try {
                const page = await readSessionHistory(
                    connected,
                    sessionId,
                    pagination.nextCursor,
                    [],
                    pagination.generation,
                    lifetime.signal,
                );
                commitProjection({ kind: "older-page", page, revision });
            } catch (cause) {
                if (lifetime.signal.aborted) {
                    return;
                }
                if (closedNow(cause, reopeningsAtStart)) {
                    commitProjection({ kind: "older-page-failed", revision, message: null });
                    get().sessionClosed(null);
                    return;
                }
                commitProjection({
                    kind: "older-page-failed",
                    revision,
                    message: formatError(cause, "Older messages could not be loaded."),
                });
                throw cause;
            }
        };
        return {
            connection: { kind: "first-loading" },
            projection: createSessionProjection(),
            followRevision: 0,
            operation: { kind: "idle" },
            turn: initialTurn,
            queued: [],
            loadOlderMessages: async (signal) => {
                if (olderHistoryLoad === null) {
                    const loading = loadOlderHistory().finally(() => {
                        if (olderHistoryLoad === loading) {
                            olderHistoryLoad = null;
                        }
                    });
                    olderHistoryLoad = loading;
                }
                await untilSettledOrAborted(olderHistoryLoad, signal);
            },
            connect: async (signal) => {
                let consecutiveFailures = 0;
                // Only the first connection reuses the access that opened the Session. Every reconnection asks Chat
                // again, so access that ended meanwhile, including a revoked Session credential, ends the page's access.
                let openedAccess = session.result.action === "conversation" ? session.result.access : undefined;
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
                    const access = openedAccess;
                    openedAccess = undefined;
                    client = await requests.connectSession(botId, sessionId, signal, access);
                    const connected = client;
                    const receiveLifecycle = async (
                        fact: SessionLifecycleFact,
                        event: SessionLiveEvent,
                    ): Promise<void> => {
                        if (
                            fact.kind !== "none" &&
                            fact.kind !== "interaction-requested" &&
                            fact.kind !== "permission-resolved" &&
                            fact.kind !== "elicitation-resolved"
                        ) {
                            if (
                                executionPosition !== undefined &&
                                executionPosition.sessionGenerationId !== event.sessionGenerationId
                            ) {
                                await readExecution(connected, get().turn, signal);
                            }
                            if (
                                executionPosition !== undefined &&
                                (executionPosition.sessionGenerationId !== event.sessionGenerationId ||
                                    BigInt(event.position) <= BigInt(executionPosition.throughPosition))
                            ) {
                                return;
                            }
                            // Unversioned peers keep the existing reconciliation path.
                            if (executionPosition !== undefined) {
                                executionPosition = {
                                    sessionGenerationId: event.sessionGenerationId,
                                    throughPosition: event.position,
                                };
                            }
                        }
                        switch (fact.kind) {
                            case "interaction-requested":
                            case "permission-resolved":
                            case "elicitation-resolved":
                                await interactions
                                    .getState()
                                    .apply(
                                        fact,
                                        event,
                                        async (readSignal) =>
                                            sessionInteractionRecovery(
                                                await connected.sessions.readSessionExecution(
                                                    sessionId,
                                                    sessionIdentity,
                                                    readSignal,
                                                ),
                                            ),
                                        signal,
                                    );
                                return;
                            case "queue-changed":
                                await readExecution(connected, get().turn, signal);
                                return;
                            case "turn-started":
                                observeExecution({
                                    kind: "turn-started",
                                    commandId: fact.commandId,
                                    startedAt: Date.parse(event.recordedAt),
                                });
                                return;
                            case "turn-delegated":
                                observeExecution({ ...fact, at: Date.parse(event.recordedAt) });
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
                    const observer: MortySessionEventObserver = {
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
                            for (const event of events) {
                                // History and lifecycle processing belong to this event. Observe both immediately,
                                // so cancellation or failure in either cannot leave the other's rejection unhandled.
                                await Promise.all([
                                    dispatchProjection({ event, kind: "live-event" }, connected, signal),
                                    event.type === "acp"
                                        ? Promise.resolve()
                                        : receiveLifecycle(sessionLifecycleFact(event.payload), event),
                                ]);
                                await new Promise<void>((resolve) => queueMicrotask(resolve));
                                signal.throwIfAborted();
                            }
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
                            await submit(awaiting, "held");
                            signal.throwIfAborted();
                        }
                        // So is a rename a pane that stopped before connecting left pending.
                        void sendRename(paneSignal);
                        await subscription.completed;
                    } finally {
                        monitoring.abort();
                    }
                    signal.throwIfAborted();
                    throw sessionUpdatesEndedError();
                };
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
                            outcome: cause instanceof MortyError ? cause.code : "bridge_unavailable",
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
                composer.getState().setDraft(draft);
            },
            send: async () => {
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const draft = composer.getState().draft;
                if (!composerHasMessage(draft, attachments.length, attachmentState.kind === "reading")) {
                    return;
                }
                await sendMessage(draft, attachments, "composer");
            },
            chooseAnswer: (messageId, questionIndex, answer) => {
                const open = new Set(openAgentQuestions(timelineMessages()).keys());
                composer.getState().chooseAnswer(open, messageId, questionIndex, answer);
            },
            sendAnswer: async (messageId) => {
                const answer = pickedAnswer(messageId);
                if (answer !== null) {
                    await sendMessage(answer, [], "answer");
                }
            },
            removeUnknownDelivery: () => {
                delivery.getState().discardUnknown();
            },
            retryUnknownDelivery: async () => {
                const state = delivery.getState().state;
                if (state.kind !== "delivery-unknown" || !canRetryUnknownDelivery(operationFacts())) {
                    return;
                }
                const pending = state.journal;
                if (pending.placement === "turn") {
                    updateTurn({ kind: "new-turn-submitted" });
                }
                // Without a record of when this browser sent it, the retry dates the command's work.
                const retrying = submitCommand(client, pending.commandId, Date.now());
                await delivery.getState().retry(retrying);
                // The Runtime's account may already show the accepted message.
                deliveryObserved({});
            },
            retryFailedMessage: async () => {
                const state = delivery.getState().state;
                const message =
                    state.kind === "preparation-failed"
                        ? // Nothing reached the Runtime, so the message keeps its identity.
                          state.message
                        : state.kind === "failed"
                          ? // The Runtime definitively rejected this identity and will not run it again.
                            { ...journalMessage(state.journal), commandId: crypto.randomUUID() }
                          : null;
                if (message === null || !canRetryFailedMessage(operationFacts())) {
                    return;
                }
                await submit(message, "held");
            },
            editFailedMessage: () => {
                if (composerAttachments.getState().state.kind === "reading") {
                    return;
                }
                const message = delivery.getState().takeFailedMessage();
                if (message === null) {
                    return;
                }
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                composer
                    .getState()
                    .returnMessage(
                        message.content,
                        message.attachments.kind === "uploaded" && message.attachments.values.length > 0,
                    );
                if (message.attachments.kind === "local") {
                    composerAttachments
                        .getState()
                        .restore([...message.attachments.values, ...composerAttachments.getState().attachments]);
                }
            },
            discardFailedMessage: () => {
                delivery.getState().takeFailedMessage();
            },
            steerQueued: async (commandId, signal) => {
                if (await messageQueue.getState().steerMessage(queuedMessage(commandId), signal)) {
                    set({ followRevision: get().followRevision + 1 });
                }
            },
            deleteQueued: async (commandId, signal) =>
                await messageQueue.getState().deleteMessage(queuedMessage(commandId), signal),
            editQueued: async (commandId, signal) =>
                await messageQueue.getState().editMessage(queuedMessage(commandId), signal),
            configure: async (option, value, booleanValue, signal) => {
                if (!canChangeSettings(operationFacts())) {
                    return;
                }
                await settings.getState().configure(sessionIdentity, option, value, booleanValue, signal);
            },
            openTitleEdit: () => {
                // A new edit replaces the failure the last rename left.
                if (rename.getState().rename.kind === "failed") {
                    rename.getState().clear();
                }
                composer.getState().openTitleEdit(sessionTitle(titles.getState().titles, sessionId));
            },
            setTitleDraft: (draft) => composer.getState().setTitleDraft(draft),
            cancelTitleEdit: () => composer.getState().closeTitleEdit(),
            confirmTitleEdit: async (signal) => {
                const draft = composer.getState().titleDraft;
                if (draft === null) {
                    return;
                }
                composer.getState().closeTitleEdit();
                const trimmed = draft.trim();
                if (trimmed.length === 0 || trimmed === sessionTitle(titles.getState().titles, sessionId)) {
                    return;
                }
                rename.getState().confirm(trimmed);
                // This pane sends the rename while it lasts; a pane that stops first leaves it to the next one.
                await sendRename(AbortSignal.any([signal, lifetime.signal]));
            },
            stop: async (signal) => await tasks.getState().stop(acceptedTurn(get().turn), signal),
        };
    });
    const welcome = createSessionWelcomeStore({
        botId,
        sessionId,
        fillEmptyDraft: (text) => {
            const presentation = sessionPanePresentation(
                store.getState(),
                composer.getState(),
                rename.getState(),
                delivery.getState(),
                tasks.getState(),
                messageQueue.getState(),
                composerAttachments.getState(),
                interactions.getState(),
                settings.getState(),
                options.connectionAvailable(store.getState().connection),
            );
            if (!presentation.canSuggestProgress) {
                return false;
            }
            store.getState().setDraft(text);
            return true;
        },
    });
    /**
     * Sends the rename the Session holds once this pane's connection is ready, within its own budget, and then any
     * title confirmed meanwhile. A pane that stops first leaves the rename pending for the next pane that connects; a
     * connection that fails or closes fails or closes the rename.
     */
    const sendPendingRenames = async (signal: AbortSignal): Promise<void> => {
        for (;;) {
            const pending = rename.getState().rename;
            if (pending.kind !== "pending" || signal.aborted) {
                return;
            }
            const reopeningsAtStart = reopenings;
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
            try {
                const connected = await waitForConnectionReady(requestSignal);
                const result = await connected.sessions.rename(sessionId, pending.title, requestSignal);
                titles.getState().observed(sessionId, result.title);
                rename.getState().settled(pending.title);
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                if (closedNow(cause, reopeningsAtStart)) {
                    rename.getState().clear();
                    store.getState().sessionClosed(null);
                    return;
                }
                rename
                    .getState()
                    .failed(
                        pending.title,
                        cause instanceof Error ? cause.message : "The conversation could not be renamed.",
                    );
            }
        }
    };
    /** The renames this pane is sending; one sender at a time, so a pane never sends the Session's rename twice at once. */
    let renaming: Promise<void> | null = null;
    const sendRename = (signal: AbortSignal): Promise<void> => {
        if (renaming === null) {
            const sending = sendPendingRenames(signal).finally(() => {
                if (renaming === sending) {
                    renaming = null;
                }
            });
            renaming = sending;
        }
        return renaming;
    };
    /** This pane's connection once ready; the pane lends it to the Session while it runs, so the Session's is this one. */
    const waitForConnectionReady = (signal: AbortSignal): Promise<MortyClient> =>
        options.sessionPage.connection.ready(signal);
    const readFile = async (path: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const current = store.getState().connection;
        if (current.kind !== "ready") {
            throw new MortyError("session_not_connected", "The Session is not connected.");
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
        // This pane now follows the Session for the page: it shows the settings it opened with and the running turn
        // it knows, and lends the Session's operations its connection. What the user asked the Session stays.
        settings.getState().opened(session.result.ready);
        tasks.getState().turnChanged(acceptedTurn(store.getState().turn)?.commandId ?? null);
        interactions.getState().restore([]);
        follower = options.sessionPage.connection.follow();
        lendConnection(store.getState().connection);
        const unregisterDebug = registerMortyDebugSession({
            sessionId,
            blocks: () => sessionDebugBlocks({ messages: timelineMessages() }),
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
     * Ends the pane: its connection and everything bound to its lifetime. The Session's operations go on, waiting for
     * the next pane's connection. The owner stops a pane it replaces or removes; a stopped pane is never restarted.
     * Idempotent.
     */
    const stop = (): void => {
        if (phase === "stopped") {
            return;
        }
        phase = "stopped";
        follower?.stopped();
        follower = null;
        filePreview.getState().close();
        lifetime.abort(new Error("The session pane stopped."));
        options.onReleased?.(sessionActivity(store.getState().turn, delivery.getState().state));
    };
    // Views read the pane's state and invoke the user's actions; the connection loop stays with `start`.
    const paneStore: StoreApi<SessionPaneStore> = store;
    return {
        composer,
        composerAttachments,
        attachmentSignal: options.attachmentSignal,
        interactions,
        settings,
        store: paneStore,
        delivery,
        rename,
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
        /** Whether the Session's Agent lets a queued message steer the running turn. */
        steeringSupported: session.result.ready.capabilities.steering,
        start,
        stop,
        reconnect,
        /**
         * The signal for what the user asks the Session to do: the Session's operations lifetime on this page, which
         * switching panes does not end.
         */
        operationsSignal: () => options.sessionPage.lifetime,
        readResource,
    };
}
