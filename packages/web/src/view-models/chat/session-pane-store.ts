import {
    type MobiusClient,
    MobiusElicitationResponseRequest,
    MobiusError,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    type MobiusSessionEventObserver,
    type PromptResource,
    SESSION_CLOSED_ERROR_CODE,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import type { SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import {
    type ComposerAttachmentStore,
    createComposerAttachmentStore,
} from "../../components/chat/composer-attachment-store.ts";
import { registerMortyDebugSession } from "../../debug-bridge.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import { saveLastHarnessPreference } from "../../services/chat/last-harness-preference.ts";
import { centralIndexedDB, sessionLastSentMessageEntry } from "../../services/indexed-db/central-indexed-db.ts";
import { centralSessionStorage, sessionDraftEntry } from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableRuntimeConnectionFailure, isSessionClosedFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import type { QueuedDraftMessage } from "./conversation-creation-machine.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import { nativeSessionAgentTabs } from "./native-session-agents.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { type SessionActivityState, sameSessionActivity, workingCommandId } from "./session-activity-machine.ts";
import {
    connectionFailure,
    disconnectedConnection,
    isConnectionSettled,
    type SessionConnection,
    sessionReconnectAttempt,
    sessionUpdatesEndedError,
} from "./session-connection.ts";
import {
    acceptedTurn,
    awaitsService,
    type CurrentTurn,
    type CurrentTurnEvent,
    idleTurn,
    openedTurn,
    transitionCurrentTurn,
    turnActivity,
} from "./session-current-turn.ts";
import { sessionDebugBlocks } from "./session-debug-blocks.ts";
import { createSessionDeliveryStore, type Journal, type SessionDeliveryStore } from "./session-delivery-store.ts";
import { createSessionInteractionStore, type SessionInteractionStore } from "./session-interaction-store.ts";
import { requestedInteraction, type SessionLifecycleFact, sessionLifecycleFact } from "./session-lifecycle.ts";
import { createSessionMessageQueueStore, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import type { ElicitationInteractionResponse, PermissionInteractionResponse } from "./session-pane-types.ts";
import {
    createSessionMessageReduction,
    type SessionMessage,
    sessionEventCommandIds,
    sessionReductionMessages,
} from "./session-presentation.ts";
import {
    createSessionProjection,
    type SessionEventHistory,
    type SessionProjectionEffect,
    type SessionProjectionInput,
    sessionProjectionExecutionOwner,
    sessionProjectionMessages,
    sessionProjectionPagination,
    transitionSessionProjection,
} from "./session-projection.ts";
import { createSessionSettingsStore } from "./session-settings-store.ts";
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";
import { createSessionTurnLedger } from "./session-turn-ledger.ts";
import { createSessionWelcomeStore } from "./session-welcome-store.ts";

export type SessionPaneModel = ReturnType<typeof createSessionPaneModel>;

type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };

function finishPromptOperation(operation: Operation, commandId: string): Operation {
    if (operation.kind === "sending" && operation.commandId === commandId) {
        return { kind: "idle" };
    }
    return operation;
}

type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string };

export type { SessionConnection } from "./session-connection.ts";

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
export interface SessionPaneStore {
    readonly connection: SessionConnection;
    readonly title: string;
    readonly titleEdit: TitleEdit;
    readonly messages: readonly SessionMessage[];
    readonly pendingInitialMessage: QueuedDraftMessage | null;
    readonly historyLoading: boolean;
    readonly historyRevision: number;
    readonly hasOlderHistory: boolean;
    readonly draft: string;
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
    readonly operation: Operation;
    readonly activity: SessionActivityState;
    /** Display-only harness list; loading failures leave the current harness. */
    readonly harnesses: readonly {
        readonly agentRef?: string;
        readonly installed?: boolean;
        readonly label: string;
        readonly value: string;
    }[];
    readonly connect: (signal: AbortSignal) => Promise<void>;
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
    readonly retryUnknownDelivery: (signal: AbortSignal) => Promise<void>;
    readonly queueDraft: (signal: AbortSignal) => Promise<void>;
    readonly steerQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly deleteQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
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
    readonly refreshSettings: (signal: AbortSignal) => Promise<void>;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
    attachments: ComposerAttachmentStore,
    interactions: SessionInteractionStore,
) {
    const needsApproval = interactions.interactions.some(
        (interaction) => interaction.kind === "permission" && interaction.permission.state.kind === "pending",
    );
    const waitingForInput = interactions.interactions.some(
        (interaction) =>
            (interaction.kind === "permission" && interaction.permission.state.kind !== "resolved") ||
            (interaction.kind === "elicitation" &&
                (interaction.elicitation.state.kind === "pending" ||
                    interaction.elicitation.state.kind === "submitted")),
    );
    const controlRunning =
        tasks.operation.kind === "running" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const composerDisabled =
        model.connection.kind !== "ready" ||
        delivery.state.kind === "submitting" ||
        delivery.state.kind === "delivery-unknown" ||
        model.operation.kind === "sending" ||
        model.operation.kind === "configuring" ||
        waitingForInput ||
        queue.operation.kind === "submitting" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const composerInputDisabled =
        (model.connection.kind !== "ready" && model.connection.kind !== "loading") ||
        delivery.state.kind === "submitting" ||
        delivery.state.kind === "delivery-unknown" ||
        model.operation.kind === "sending" ||
        model.operation.kind === "configuring" ||
        waitingForInput ||
        queue.operation.kind === "submitting" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const workingActivityCommandId = workingCommandId(model.activity);
    const submittingCommandId = model.operation.kind === "sending" ? model.operation.commandId : null;
    const activeCommandId = workingActivityCommandId ?? submittingCommandId;
    const busy = activeCommandId !== null || composerDisabled;
    const activeMessageId =
        workingActivityCommandId !== null || submittingCommandId !== null
            ? (model.messages.findLast((message) => message.role === "assistant")?.firstEvent.eventId ?? null)
            : null;
    const deliveryUnknownCommandId =
        delivery.state.kind === "delivery-unknown" ? delivery.state.journal.commandId : null;
    const deliveryUnknownUserMessageId = deliveryUnknownCommandId === null ? null : deliveryUnknownCommandId;
    // A recovered journal was never accepted by the service, so the projection
    // has no user message for it. Expose the submission itself so the view can
    // render an independent recovery card with retry and remove controls. Once
    // the service confirms the turn, history supplies the message and the card
    // disappears.
    const unconfirmed = delivery.state.kind === "delivery-unknown" ? delivery.state.journal : null;
    const unconfirmedDelivery =
        unconfirmed === null ||
        model.messages.some((message) => message.role === "user" && message.commandId === unconfirmed.commandId)
            ? null
            : {
                  commandId: unconfirmed.commandId,
                  displayPrompt: unconfirmed.displayPrompt,
                  images: unconfirmed.request.images,
                  resources: unconfirmed.request.resources,
              };
    return {
        activeMessageId,
        activeCommandId,
        busy,
        composerDisabled,
        composerInputDisabled,
        canSuggestProgress:
            !busy &&
            !controlRunning &&
            model.draft.length === 0 &&
            attachments.attachments.length === 0 &&
            attachments.state.kind !== "reading",
        // Operations that failed because the Session closed say nothing the closed notice does not already say.
        composerError:
            connectionFailure(model.connection) ??
            (model.connection.kind === "closed"
                ? ""
                : ([model.activity, model.operation, delivery.state, tasks.feedback, queue.feedback].find(
                      (state) => state.kind === "failed",
                  )?.message ?? "")),
        controlRunning,
        deliveryUnknownUserMessageId,
        hasOlderHistory: model.hasOlderHistory,
        historyLoading: model.historyLoading,
        outputState:
            queue.operation.kind === "submitting"
                ? "sending"
                : tasks.operation.kind === "stopping"
                  ? "stopping"
                  : model.operation.kind === "sending" || delivery.state.kind === "submitting"
                    ? "sending"
                    : controlRunning
                      ? "running"
                      : "idle",
        workingIndicatorVisible:
            !needsApproval &&
            activeCommandId !== null &&
            model.messages.some((message) => message.role === "user" && message.commandId === activeCommandId),
        shouldQueueOnSubmit: tasks.operation.kind === "running",
        submitDisabled:
            model.connection.kind !== "ready" ||
            (tasks.operation.kind === "running" ? queue.operation.kind !== "idle" : busy) ||
            attachments.state.kind === "reading" ||
            (model.draft.trim() === "" && attachments.attachments.length === 0),
        unconfirmedDelivery,
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
): Promise<SessionEventHistory> {
    let events: readonly SessionEvent[] = newerEvents;
    let nextCursor = initialCursor;
    let sessionGenerationId = expectedSessionGenerationId;
    let renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    do {
        const requestedCursor = nextCursor;
        const page = await client.events.list(
            sessionId,
            new MobiusPageRequest(SESSION_EVENT_PAGE_LIMIT, requestedCursor ?? ""),
            signal,
            { omit: ["agent-reasoning"] },
        );
        signal.throwIfAborted();
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
    } while (nextCursor !== null && renderableMessages.length < HISTORY_MESSAGE_TARGET);
    if (sessionGenerationId === null) {
        throw new Error("The Runtime returned no Session history generation.");
    }
    return { events, nextCursor, sessionGenerationId };
}

/** The settings a turn submission carries, read from the options the pane shows. */
function sessionConfigurations(configOptions: readonly SessionConfigOption[]) {
    return configOptions.map((option) => ({
        booleanValue: option.type === "boolean" ? option.booleanValue : false,
        configId: option.id,
        value: option.type === "select" ? option.currentValue : "",
        valueType: option.type,
    }));
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
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "managedSession" | "runtimeConfiguration">;
    readonly initialMessage?: QueuedDraftMessage | undefined;
    /**
     * A previous pane's unconfirmed first-message submission. Adopted as the
     * delivery journal so the user can retry or discard it, and a remount never
     * resubmits it automatically.
     */
    readonly unconfirmedMessage?: Journal | undefined;
    /** Invoked once after the queued first message has been sent. */
    readonly onInitialMessageDelivered?: (() => void) | undefined;
    /** Invoked when the queued first message can no longer be delivered by this pane. */
    readonly onInitialMessageRecoveryCleared?: ((commandId: string) => void) | undefined;
    /** Invoked when the submission of the queued first message was not confirmed. */
    readonly onInitialMessageUnconfirmed?: ((journal: Journal) => void) | undefined;
    /** Reports session activity transitions, such as a running turn, to the owner. */
    readonly onStatusChange?: ((status: SessionActivityState) => void) | undefined;
    readonly onTitleChange: (sessionId: string, title: string) => void;
}) {
    const { session, botId, requests, clock } = options;
    const composerAttachments = createComposerAttachmentStore(options.initialMessage?.attachments);
    const sessionId = session.result.ready.sessionId;
    // Working in a conversation makes it the reference for the next draft: its
    // harness and the settings it runs with carry into New Session.
    saveLastHarnessPreference(botId, session.agentRef);
    saveLastAgentSettings(botId, session.agentRef, session.result.ready.configOptions);
    const settings = createSessionSettingsStore({
        botId,
        agentRef: session.agentRef,
        initial: session.result.ready.configOptions,
    });
    const fallbackStartedAt = Date.now();
    // The one record of the current turn. `updateTurn` moves it together with the activity and the stop control.
    let currentTurn: CurrentTurn =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? openedTurn({
                  commandId: session.result.activeTurn.commandId,
                  turnId: session.result.activeTurn.turnId,
                  startedAt: fallbackStartedAt,
              })
            : idleTurn;
    const turns = createSessionTurnLedger({ initialCommandId: options.initialMessage?.commandId ?? null });
    let client: MobiusClient | null = null;
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
    let draftRevision = 0;
    // The queued first message stays the pane's recovery responsibility until
    // the service accepts it or the user discards it, not just until the send
    // starts.
    const queuedInitialCommandId = options.initialMessage?.commandId ?? options.unconfirmedMessage?.commandId ?? null;
    const isQueuedInitialMessage = (commandId: string): boolean => commandId === queuedInitialCommandId;
    const instructionUri = "morty://bot/instructions";
    const withInstructions = <T extends { readonly resources: readonly PromptResource[] }>(request: T): T => ({
        ...request,
        resources: [
            ...request.resources.filter((resource) => resource.uri !== instructionUri),
            ...((session.instructions ?? "").trim().length === 0
                ? []
                : [
                      {
                          mimeType: "text/plain",
                          name: "Agent instructions",
                          text: session.instructions ?? "",
                          type: "embedded" as const,
                          uri: instructionUri,
                      },
                  ]),
        ],
    });
    const delivery = createSessionDeliveryStore({
        submit: noticingClosure(async (request, signal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            return await client.turns.submit(
                sessionId,
                withInstructions({
                    ...request,
                    agentId: session.agentRef,
                    directoryId: session.result.ready.directoryId,
                    sessionConfigurations: sessionConfigurations(settings.getState().options),
                }),
                signal,
            );
        }),
        initialUnknown: options.unconfirmedMessage,
    });
    const lastSentMessageEntry = sessionLastSentMessageEntry(sessionId);
    const deriveTimeline = (): { readonly messages: readonly SessionMessage[] } => ({
        messages: sessionProjectionMessages(projection),
    });
    const tasks = createSessionTaskControlsStore({
        steeringSupported: session.result.ready.capabilities.steering,
        port: {
            cancel: noticingClosure(async (turnId, idempotencyKey, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
            }),
            submit: noticingClosure(async (request, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.submit(
                    sessionId,
                    withInstructions({
                        ...request,
                        agentId: session.agentRef,
                        directoryId: session.result.ready.directoryId,
                    }),
                    signal,
                );
            }),
        },
    });
    const openedRunning = acceptedTurn(currentTurn);
    if (openedRunning !== null) {
        tasks.getState().start(openedRunning.commandId, openedRunning.turnId);
    }
    const messageQueue = createSessionMessageQueueStore({
        port: {
            cancel: noticingClosure(async (turnId, idempotencyKey, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
            }),
            steer: noticingClosure(async (turnId, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                await client.turns.steer(sessionId, turnId, signal);
            }),
            submit: noticingClosure(async (request, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.submit(
                    sessionId,
                    withInstructions({
                        ...request,
                        agentId: session.agentRef,
                        directoryId: session.result.ready.directoryId,
                    }),
                    signal,
                );
            }),
        },
    });
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };
    const sessionIdentity: SessionIdentity = {
        additionalDirectoryIds: session.entry.additionalDirectories.map((directory) => directory.directoryId),
        agentId: session.agentRef,
        directoryId: session.result.ready.directoryId,
    };
    const draftEntry = sessionDraftEntry(sessionId);
    const initialTimeline = deriveTimeline();

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
        permission: respondToPermission,
        elicitation: respondToElicitation,
    });

    // Activity transitions are reported to the owner through this latch at
    // the explicit sites that change activity; connection waiters are woken
    // where the connection settles. No wrapped set, no subscriptions.
    let reportedStatus: SessionActivityState | null = null;
    const connectionWaiters = new Set<() => void>();
    const store = createStore<SessionPaneStore>()((set, get) => {
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
                | SessionPaneStore
                | Partial<SessionPaneStore>
                | ((state: SessionPaneStore) => SessionPaneStore | Partial<SessionPaneStore>),
        ): void => {
            set(partial);
            settleConnectionWaiters();
        };
        // Reports an activity transition to the owner through the latch; the
        // explicit sites that change activity call this right after their set.
        const announceActivity = (): void => {
            const activity = get().activity;
            if (activity !== reportedStatus) {
                reportedStatus = activity;
                options.onStatusChange?.(activity);
            }
        };
        /**
         * Moves the current turn, and with it the activity the pane shows and the running turn the stop control acts
         * on. Callers announce the activity once their other updates are in.
         */
        const updateTurn = (event: CurrentTurnEvent): void => {
            const previous = acceptedTurn(currentTurn);
            currentTurn = transitionCurrentTurn(currentTurn, event);
            const accepted = acceptedTurn(currentTurn);
            if ((event.kind === "running" || event.kind === "accepted") && accepted?.commandId === event.commandId) {
                tasks.getState().start(accepted.commandId, accepted.turnId);
            } else if (previous !== null && previous.commandId !== accepted?.commandId) {
                tasks.getState().finish(previous.commandId);
            }
            const activity = turnActivity(currentTurn);
            if (!sameSessionActivity(activity, get().activity)) {
                set({ activity });
            }
        };
        let historyLoadController: AbortController | null = null;
        const commitProjection = (input: SessionProjectionInput): readonly SessionProjectionEffect[] => {
            const result = transitionSessionProjection(projection, input);
            projection = result.state;
            const pagination = sessionProjectionPagination(projection);
            const messages = sessionProjectionMessages(projection);
            const initialMessage = get().pendingInitialMessage;
            set({
                hasOlderHistory: pagination !== null,
                historyRevision: projection.revision,
                messages,
                pendingInitialMessage:
                    initialMessage !== null &&
                    messages.some(
                        (message) => message.role === "user" && message.commandId === initialMessage.commandId,
                    )
                        ? null
                        : initialMessage,
            });
            for (const effect of result.effects) {
                if (effect.kind !== "adopted") {
                    continue;
                }
                if (effect.config !== undefined) {
                    settings.getState().adopt(effect.config);
                }
                if (effect.title !== undefined) {
                    set({ title: effect.title });
                    options.onTitleChange(sessionId, effect.title);
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
            try {
                const history = await readSessionHistory(
                    connected,
                    sessionId,
                    null,
                    [],
                    effect.generation,
                    AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]),
                );
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || projection.pending === null || projection.revision !== revision) {
                    return;
                }
                commitProjection({ history, kind: "history-loaded", revision });
                delivery.getState().reconcile(sessionEventCommandIds(history.events));
            } catch (cause) {
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || projection.revision !== revision) {
                    return;
                }
                throw cause;
            } finally {
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
            let historyReloaded = false;
            for (const effect of effects) {
                if (effect.kind === "load-history") {
                    await loadProjectionHistory(effect, connected, signal);
                    historyReloaded = true;
                }
            }
            // A reloaded log without any config event is the post-restart shape.
            if (historyReloaded && projection.kind === "established" && projection.config === null) {
                settings
                    .getState()
                    .readInBackground(
                        (readSignal) => connected.sessions.readConfiguration(sessionId, readSignal),
                        signal,
                    );
            }
        };
        // A closed Session runs nothing. Settles the turn, queue and interactions it was holding, the way a
        // reconnect finds them when the Session reports no running turn.
        const settleClosedExecution = (): void => {
            commitProjection({ kind: "execution-idle" });
            messageQueue.getState().replace([]);
            updateTurn({ kind: "nothing-running" });
            interactions.getState().restore([]);
            announceActivity();
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
                settleClosedExecution();
                setAndSettle({ connection: { kind: "closed", reason, reopen: { kind: "available" } } });
            });
        };
        return {
            connection:
                options.initialMessage === undefined ? { kind: "loading" } : { kind: "session-loading-after-create" },
            title: session.entry.title,
            titleEdit: { kind: "closed" },
            messages: initialTimeline.messages,
            pendingInitialMessage: options.initialMessage ?? null,
            historyLoading: false,
            historyRevision: 0,
            hasOlderHistory: false,
            draft: options.initialMessage?.content ?? centralSessionStorage.read(draftEntry) ?? "",
            harnesses: [{ agentRef: session.agentRef, label: session.agentRef, value: session.agentRef }],
            followRevision: 0,
            operation: { kind: "idle" },
            activity: turnActivity(currentTurn),
            loadOlderMessages: async (signal) => {
                const pagination = sessionProjectionPagination(projection);
                if (loadingOlderHistory || pagination === null || client === null) {
                    return;
                }
                loadingOlderHistory = true;
                set({ historyLoading: true });
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
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        get().sessionClosed(null);
                        return;
                    }
                    set({
                        operation: {
                            kind: "failed",
                            message: formatError(cause, "Older messages could not be loaded."),
                        },
                    });
                    throw cause;
                } finally {
                    loadingOlderHistory = false;
                    if (!signal.aborted) {
                        set({ historyLoading: false });
                    }
                }
            },
            connect: async (signal) => {
                // Each connect starts from an empty projection: the history
                // reload re-reads persisted events (reasoning text omitted
                // server-side), so a re-attached view never renders stale
                // in-memory content the service no longer returns.
                projection = createSessionProjection();
                set({ messages: sessionProjectionMessages(projection) });
                const readStoredLastSentMessage = (): void => {
                    const revision = turns.lastSentRevision();
                    void centralIndexedDB.get(lastSentMessageEntry, signal).then((stored) => {
                        if (stored === null || !turns.adoptStoredSent(stored, revision)) {
                            return;
                        }
                        updateTurn({ kind: "sent-at-known", commandId: stored.commandId, sentAt: stored.sentAt });
                        announceActivity();
                    });
                };
                let consecutiveFailures = 0;
                const paneSignal = signal;
                // The signal is this attempt's own: the pane's lifetime, and also the closing of the Session.
                const observeSession = async (signal: AbortSignal): Promise<void> => {
                    client = await requests.connectSession(
                        botId,
                        sessionId,
                        signal,
                        session.result.action === "conversation" ? session.result.access : undefined,
                    );
                    const connected = client;
                    const receiveLifecycle = async (fact: SessionLifecycleFact): Promise<void> => {
                        switch (fact.kind) {
                            case "interaction-requested":
                            case "permission-resolved":
                            case "elicitation-resolved":
                                interactions.getState().apply(fact);
                                return;
                            case "queue-changed": {
                                const execution = await connected.sessions.readSessionExecution(
                                    sessionId,
                                    sessionIdentity,
                                    signal,
                                );
                                signal.throwIfAborted();
                                messageQueue.getState().replace(execution.queued);
                                return;
                            }
                            case "turn-started": {
                                delivery.getState().reconcile([fact.commandId]);
                                const queued = messageQueue.getState().takeStarted(fact.commandId);
                                const owner = sessionProjectionExecutionOwner(projection, fact.commandId);
                                if (owner !== null && owner !== fact.commandId) {
                                    // Steering starts a command, not a new execution to stop.
                                    return;
                                }
                                const accepted = acceptedTurn(currentTurn);
                                updateTurn({
                                    kind: "running",
                                    commandId: fact.commandId,
                                    turnId:
                                        queued?.turnId ??
                                        (accepted?.commandId === fact.commandId ? accepted.turnId : fact.commandId),
                                    startedAt: turns.startedAt(fact.commandId, Date.now()),
                                });
                                announceActivity();
                                return;
                            }
                            case "turn-completed":
                            case "turn-failed": {
                                delivery.getState().reconcile([fact.commandId]);
                                if (fact.kind === "turn-completed" && fact.steered) {
                                    const execution = await connected.sessions.readSessionExecution(
                                        sessionId,
                                        sessionIdentity,
                                        signal,
                                    );
                                    signal.throwIfAborted();
                                    const running = execution.turn;
                                    if (running !== null) {
                                        updateTurn({
                                            kind: "running",
                                            commandId: running.commandId,
                                            turnId: running.commandId,
                                            startedAt: turns.startedAt(running.commandId, Date.now()),
                                        });
                                        const timeline = deriveTimeline();
                                        set({
                                            messages: timeline.messages,
                                            operation: finishPromptOperation(get().operation, fact.commandId),
                                        });
                                        announceActivity();
                                        return;
                                    }
                                }
                                updateTurn({
                                    kind: "ended",
                                    commandId: fact.commandId,
                                    failure: fact.kind === "turn-failed" ? fact.message : null,
                                });
                                const completed = deriveTimeline();
                                set({
                                    messages: completed.messages,
                                    operation: finishPromptOperation(get().operation, fact.commandId),
                                });
                                announceActivity();
                                return;
                            }
                            case "none":
                                return;
                            default:
                                return fact satisfies never;
                        }
                    };
                    const observer: MobiusSessionEventObserver = {
                        reconcile: async (connection) => {
                            const reconcilingTurn = currentTurn;
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
                                            message: connectionFailure(get().connection),
                                        },
                                    });
                                    break;
                            }
                            await dispatchProjection({ kind: "reconcile" }, connected, signal);
                            signal.throwIfAborted();
                            // Confirm execution after history is adopted. An earlier idle snapshot
                            // cannot settle work that started while those pages were loading.
                            const execution = await connected.sessions.readSessionExecution(
                                sessionId,
                                sessionIdentity,
                                signal,
                            );
                            signal.throwIfAborted();
                            const running = execution.turn;
                            if (running === null) {
                                commitProjection({ kind: "execution-idle" });
                            }
                            messageQueue.getState().replace(execution.queued);
                            if (running !== null) {
                                const accepted = acceptedTurn(reconciliation.turn);
                                updateTurn({
                                    kind: "running",
                                    commandId: running.commandId,
                                    turnId:
                                        accepted?.commandId === running.commandId ? accepted.turnId : running.commandId,
                                    startedAt: turns.startedAt(running.commandId, Date.now()),
                                });
                            } else if (awaitsService(reconciliation.turn)) {
                                updateTurn({ kind: "nothing-running" });
                            }
                            signal.throwIfAborted();
                            const interaction = execution.turn?.interaction;
                            interactions
                                .getState()
                                .restore(
                                    interaction === undefined || interaction === null
                                        ? []
                                        : [requestedInteraction(interaction)],
                                );
                            announceActivity();
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
                                    }
                                }
                                if (event.type !== "acp") {
                                    await receiveLifecycle(sessionLifecycleFact(event.payload));
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
                    consecutiveFailures = 0;
                    setAndSettle({ connection: { kind: "ready", client: connected } });
                    welcome.getState().connected();
                    if (turns.hasInitialCommand()) {
                        // Send reports delivery itself, so an uncertain or
                        // rejected submission leaves the queued message and its
                        // idempotent command id in the home store for a remount
                        // to recover.
                        // The send belongs to the pane, not to this attempt: a closing of the Session must not
                        // abandon a submission that is already on its way.
                        await get().send(paneSignal);
                        signal.throwIfAborted();
                    }
                    // A detach between submit and the delivery report can still
                    // re-send the queued message on re-attach. That is safe:
                    // the command id is the turn submit's idempotency key, so
                    // the service deduplicates the repeated submission.
                    await subscription.completed;
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
                        setAndSettle({ connection: { kind: "reconnecting", message: null } });
                    }
                    if (consecutiveFailures > 0) {
                        setAndSettle({
                            connection: { kind: "reconnecting", message: connectionFailure(get().connection) },
                        });
                    }
                    const running = new AbortController();
                    attempt = running;
                    try {
                        await observeSession(AbortSignal.any([signal, running.signal]));
                    } catch (cause) {
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
                        if (!isRetryableRuntimeConnectionFailure(cause)) {
                            const message = formatError(cause, "The Session could not be opened.");
                            setAndSettle({
                                connection: { kind: "failed", message },
                            });
                            return;
                        }
                        const retry = sessionReconnectAttempt(consecutiveFailures);
                        consecutiveFailures += 1;
                        const message = formatError(cause, "The Session could not be opened.");
                        setAndSettle({
                            connection: disconnectedConnection(
                                message,
                                retry.kind === "scheduled" ? retry.delayMs : null,
                            ),
                        });
                        countdownInterrupt = new AbortController();
                        const retrySignal = AbortSignal.any([signal, countdownInterrupt.signal]);
                        try {
                            if (retry.kind === "scheduled") {
                                const retryAt = clock.now() + retry.delayMs;
                                while (clock.now() < retryAt) {
                                    await clock.sleep(Math.min(1000, retryAt - clock.now()), retrySignal);
                                    retrySignal.throwIfAborted();
                                    setAndSettle({
                                        connection: disconnectedConnection(message, retryAt - clock.now()),
                                    });
                                }
                            } else {
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
            retryNow: () => {
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
                delivery.getState().dismissFailure();
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                reopenings += 1;
                resumeAfterReopen?.();
            },
            setDraft: (draft) => {
                draftRevision += 1;
                delivery.getState().dismissFailure();
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                if (draft === "") {
                    centralSessionStorage.remove(draftEntry);
                } else {
                    centralSessionStorage.write(draftEntry, draft);
                }
                set({ draft });
            },
            send: async (signal) => {
                const current = get();
                const { attachments, state: attachmentState } = composerAttachments.getState();
                if (
                    current.connection.kind !== "ready" ||
                    attachmentState.kind === "reading" ||
                    (current.draft.trim() === "" && attachments.length === 0) ||
                    current.operation.kind === "sending" ||
                    current.operation.kind === "configuring" ||
                    tasks.getState().operation.kind !== "idle"
                ) {
                    return;
                }
                const commandId = turns.claimCommand(crypto.randomUUID());
                welcome.getState().dismiss();
                const sent = turns.recordSent(commandId, Date.now());
                void centralIndexedDB.set(lastSentMessageEntry, sent, signal);
                const prompt = current.draft.trim();
                const displayPrompt =
                    prompt ||
                    attachments
                        .map((attachment) =>
                            attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                        )
                        .join(", ");
                const images = attachments.flatMap((attachment) =>
                    attachment.kind === "image" ? [attachment.image] : [],
                );
                const submittedDraftRevision = draftRevision;
                // The submission owns this snapshot until it is accepted, journaled,
                // or returned to the composer by an authoritative rejection.
                centralSessionStorage.remove(draftEntry);
                composerAttachments.getState().clear();
                updateTurn({ kind: "submitting", commandId, startedAt: sent.sentAt });
                const pending = deriveTimeline();
                set({
                    followRevision: get().followRevision + 1,
                    operation: { kind: "sending", commandId },
                    messages: pending.messages,
                    draft: "",
                });
                try {
                    const submission = {
                        ...request,
                        content: prompt,
                        images,
                        resources: attachments.flatMap((attachment) =>
                            attachment.kind === "resource" ? [attachment.resource] : [],
                        ),
                    };
                    const outcome = await delivery.getState().submit(commandId, displayPrompt, submission, signal);
                    signal.throwIfAborted();
                    switch (outcome.kind) {
                        case "accepted":
                        case "delivery-unknown":
                            break;
                        case "rejected":
                            if (draftRevision === submittedDraftRevision) {
                                set({ draft: current.draft });
                                composerAttachments.getState().restore(attachments);
                                centralSessionStorage.write(draftEntry, current.draft);
                            }
                            if (isQueuedInitialMessage(commandId)) {
                                // This rejected message is editable again. Retire
                                // the auto-send/retry copy owned by the home store.
                                options.onInitialMessageRecoveryCleared?.(commandId);
                            }
                            break;
                        default:
                            return outcome satisfies never;
                    }
                    if (outcome.kind === "accepted") {
                        if (isQueuedInitialMessage(commandId)) {
                            options.onInitialMessageDelivered?.();
                        }
                    } else if (outcome.kind === "delivery-unknown" && isQueuedInitialMessage(commandId)) {
                        options.onInitialMessageUnconfirmed?.({ commandId, displayPrompt, request: submission });
                    }
                    if (outcome.kind === "accepted") {
                        updateTurn({ kind: "accepted", commandId, turnId: outcome.turn.turnId });
                        set({ operation: finishPromptOperation(get().operation, commandId) });
                        return;
                    }
                    updateTurn({ kind: "submission-abandoned", commandId, failure: null });
                    const restored = deriveTimeline();
                    set({
                        messages: restored.messages,
                        pendingInitialMessage: null,
                        operation: finishPromptOperation(get().operation, commandId),
                    });
                    announceActivity();
                } catch (cause) {
                    signal.throwIfAborted();
                    const message = formatError(cause, "The agent could not complete the message.");
                    updateTurn({ kind: "submission-abandoned", commandId, failure: message });
                    set({ pendingInitialMessage: null, operation: { kind: "failed", message } });
                    announceActivity();
                }
            },
            removeUnknownDelivery: () => {
                const commandId = delivery.getState().discardUnknown();
                if (commandId === null) {
                    return;
                }
                updateTurn({ kind: "submission-abandoned", commandId, failure: null });
                // Mirrors the delivery report: dropping this pane's retry path
                // must also drop the home store's recovery copy, or a remount
                // would submit the message the user just discarded.
                if (isQueuedInitialMessage(commandId)) {
                    options.onInitialMessageRecoveryCleared?.(commandId);
                }
                const restored = deriveTimeline();
                set({ messages: restored.messages });
                announceActivity();
            },
            retryUnknownDelivery: async (signal) => {
                const state = delivery.getState().state;
                if (get().connection.kind !== "ready" || state.kind !== "delivery-unknown") {
                    return;
                }
                const pending = state.journal;
                updateTurn({
                    kind: "retrying",
                    commandId: pending.commandId,
                    startedAt: turns.startedAt(pending.commandId, Date.now()),
                });
                const retried = deriveTimeline();
                set({ messages: retried.messages });
                announceActivity();
                const outcome = await delivery.getState().retry(signal);
                signal.throwIfAborted();
                switch (outcome?.kind) {
                    case "accepted":
                        if (isQueuedInitialMessage(pending.commandId)) {
                            options.onInitialMessageDelivered?.();
                        }
                        updateTurn({ kind: "accepted", commandId: pending.commandId, turnId: outcome.turn.turnId });
                        return;
                    case "rejected": {
                        const restoredAttachments = [
                            ...pending.request.images.map((image) => ({ kind: "image" as const, image })),
                            ...pending.request.resources.map((resource) => ({ kind: "resource" as const, resource })),
                        ];
                        composerAttachments.getState().restore(restoredAttachments);
                        centralSessionStorage.write(draftEntry, pending.request.content);
                        set({ draft: pending.request.content });
                        if (isQueuedInitialMessage(pending.commandId)) {
                            options.onInitialMessageRecoveryCleared?.(pending.commandId);
                        }
                        break;
                    }
                    case "delivery-unknown":
                        break;
                    case undefined:
                        return;
                    default:
                        return outcome satisfies never;
                }
                updateTurn({ kind: "submission-abandoned", commandId: pending.commandId, failure: null });
                announceActivity();
            },
            queueDraft: async (signal) => {
                const current = get();
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const controls = tasks.getState();
                if (
                    attachmentState.kind === "reading" ||
                    current.connection.kind !== "ready" ||
                    controls.operation.kind !== "running"
                ) {
                    return;
                }
                const prompt = current.draft.trim();
                const summary =
                    prompt ||
                    attachments
                        .map((attachment) =>
                            attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                        )
                        .join(", ");
                delivery.getState().dismissFailure();
                const queued = await messageQueue.getState().enqueue(
                    controls.operation.active.commandId,
                    summary,
                    {
                        ...request,
                        content: prompt,
                        images: attachments.flatMap((attachment) =>
                            attachment.kind === "image" ? [attachment.image] : [],
                        ),
                        resources: attachments.flatMap((attachment) =>
                            attachment.kind === "resource" ? [attachment.resource] : [],
                        ),
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (queued !== null) {
                    welcome.getState().dismiss();
                    const sent = turns.recordSent(queued.commandId, Date.now());
                    void centralIndexedDB.set(lastSentMessageEntry, sent, signal);
                    centralSessionStorage.remove(draftEntry);
                    composerAttachments.getState().clear();
                    set({ draft: "", followRevision: get().followRevision + 1 });
                }
            },
            steerQueued: async (commandId, signal) => {
                const steered = await messageQueue.getState().steerMessage(commandId, signal);
                signal.throwIfAborted();
                if (steered !== null) {
                    const timeline = deriveTimeline();
                    set({ messages: timeline.messages, followRevision: get().followRevision + 1 });
                }
            },
            deleteQueued: async (commandId, signal) => {
                await messageQueue.getState().deleteMessage(commandId, signal);
            },
            configure: async (option, value, booleanValue, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    return;
                }
                set({ operation: { kind: "configuring" } });
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
                            directoryId: session.result.ready.directoryId,
                            value,
                            valueType: option.type,
                        },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    settings.getState().adopt(result.configOptions);
                    set({ operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ operation: { kind: "idle" } });
                        get().sessionClosed(null);
                        return;
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
                set({ titleEdit: { draft: get().title, kind: "editing" } });
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
                    trimmed === get().title ||
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
                    set({ title: result.title, titleEdit: { kind: "closed" } });
                    options.onTitleChange(sessionId, result.title);
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ titleEdit: { kind: "closed" } });
                        get().sessionClosed(null);
                        return;
                    }
                    set({
                        titleEdit: { kind: "closed" },
                        operation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The conversation could not be renamed.",
                        },
                    });
                }
            },
            refreshSettings: async (signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    return;
                }
                set({ operation: { kind: "configuring" } });
                const reopeningsAtStart = reopenings;
                try {
                    const connected = client;
                    await dispatchProjection({ kind: "reconcile" }, connected, signal);
                    signal.throwIfAborted();
                    set({ operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (closedNow(cause, reopeningsAtStart)) {
                        set({ operation: { kind: "idle" } });
                        get().sessionClosed(null);
                        return;
                    }
                    set({
                        operation: {
                            kind: "failed",
                            message: formatError(cause, "The settings could not be reloaded."),
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
            );
            if (!presentation.canSuggestProgress) {
                return false;
            }
            store.getState().setDraft(text);
            return true;
        },
    });
    // The pane's connection lifetime: attach starts connecting with its own
    // signal, detach aborts it. The view drives this through a ref callback,
    // so no component effect owns the session connection and nothing starts
    // during render.
    const attachedViews = new WeakSet<HTMLElement>();
    // The pane's connection lifetime follows attach/detach: each attach gets a
    // fresh controller (a detach aborts the previous one), so a re-attached
    // pane reconnects instead of reusing an aborted signal.
    let connection = new AbortController();
    // The harness list is display-only in an existing conversation: every
    // entry is disabled, so a failed load just leaves the current harness.
    // The controller is re-armed on each attach so a re-attached pane can
    // refresh the list again.
    let harnessController = new AbortController();
    const loadHarnesses = (): void => {
        harnessController = new AbortController();
        const signal = harnessController.signal;
        requests
            .runtimeConfiguration(botId, signal)
            .then((configuration) => {
                if (signal.aborted) {
                    return;
                }
                store.setState({
                    harnesses: nativeSessionAgentTabs(configuration.runtime).map((agent) => ({
                        agentRef: agent.agentRef,
                        installed: agent.installed,
                        label: agent.label,
                        value: `${agent.runtimeId}:${agent.agentRef}`,
                    })),
                });
            })
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "session-pane-harnesses");
                }
            });
    };
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
            AbortSignal.any([signal, connection.signal, AbortSignal.timeout(20_000)]),
            32 * 1024 * 1024,
        );
    };
    const readResource = async (path: string, signal: AbortSignal) => {
        // The same bounded lifetime covers connection recovery and the file read.
        const requestSignal = AbortSignal.any([signal, connection.signal, AbortSignal.timeout(20_000)]);
        await waitForConnectionReady(requestSignal);
        return await readFile(path, requestSignal);
    };
    const filePreview = createBrowserFilePreviewStore(readFile);
    /**
     * Stops the pane's connection-scoped resources. Idempotent: an owning
     * workspace may stop a pane that is still attached, and the attached
     * element's own cleanup then re-runs it as a no-op.
     */
    const stop = (): void => {
        filePreview.getState().close();
        harnessController.abort(new Error("The session pane stopped."));
        connection.abort(new Error("The session pane stopped."));
    };
    /**
     * Announced with the pane's attached root element, following React's
     * ref-cleanup protocol: the view hands it straight to its root element's
     * ref. Attach starts the session connection; the returned function stops
     * it. A WeakSet latches the node so a re-render of the same element cannot
     * detach and reattach the connection.
     */
    const onAttach = (node: HTMLElement): (() => void) => {
        if (attachedViews.has(node)) {
            return () => {};
        }
        attachedViews.add(node);
        const unregisterDebug = registerMortyDebugSession({
            sessionId,
            blocks: () => sessionDebugBlocks(store.getState()),
        });
        // A previous cleanup aborted the old controllers; arm fresh ones so
        // this attach reconnects with a live signal.
        connection = new AbortController();
        loadHarnesses();
        const signal = connection.signal;
        void store
            .getState()
            .connect(signal)
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "session-pane-connect");
                }
            });
        return () => {
            attachedViews.delete(node);
            unregisterDebug();
            composerAttachments.getState().clear();
            stop();
        };
    };
    return {
        composerAttachments,
        interactions,
        settings,
        store,
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
        onAttach,
        stop,
        /** The signal for view-triggered operations while the pane is attached. */
        operationsSignal: () => connection.signal,
        readResource,
    };
}
