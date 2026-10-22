import {
    type MobiusClient,
    MobiusElicitationResponseRequest,
    MobiusError,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    type MobiusSessionEventObserver,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { decodeIdentifier, type SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import {
    type ComposerAttachmentStore,
    createComposerAttachmentStore,
} from "../../components/chat/composer-attachment-store.ts";
import { registerMortyDebugSession } from "../../debug-bridge.ts";
import { type BotChatApi, connectedChatRuntimeAgents } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import {
    centralIndexedDB,
    type SessionLastSentMessage,
    sessionLastSentMessageEntry,
} from "../../services/indexed-db/central-indexed-db.ts";
import { centralSessionStorage, sessionDraftEntry } from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableRuntimeConnectionFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import type { QueuedDraftMessage } from "./conversation-creation-machine.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { createSessionActiveTurn, type SessionActiveTurn } from "./session-active-turn.ts";
import {
    type SessionActivityState,
    startSessionWork,
    transitionSessionActivity,
    workingCommandId,
} from "./session-activity-machine.ts";
import { sessionDebugBlocks } from "./session-debug-blocks.ts";
import { createSessionDeliveryStore, type Journal, type SessionDeliveryStore } from "./session-delivery-store.ts";
import { createSessionInteractionStore } from "./session-interaction-store.ts";
import { createSessionMessageQueueStore, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "./session-pane-types.ts";
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
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";

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
type Connection =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly client: MobiusClient }
    | { readonly kind: "reconnecting"; readonly message: string | null }
    | {
          readonly kind: "disconnected";
          readonly message: string;
          readonly retry:
              | { readonly kind: "scheduled"; readonly remainingSeconds: number }
              | { readonly kind: "exhausted" };
      }
    | { readonly kind: "failed"; readonly message: string };

function connectionFailure(connection: Connection): string | null {
    switch (connection.kind) {
        case "disconnected":
        case "failed":
        case "reconnecting":
            return connection.message;
        case "loading":
        case "ready":
            return null;
    }
}

export type SessionConnection = Connection;
type LocalInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
const SESSION_RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const SESSION_RECONNECT_DELAY_CAP_MS = 30_000;
const SESSION_AUTO_RECONNECT_ATTEMPTS = 7;
function interactionId(interaction: LocalInteraction): string {
    return interaction.kind === "permission"
        ? interaction.permission.interactionId
        : interaction.elicitation.interactionId;
}

function replaceInteraction(
    current: readonly LocalInteraction[],
    id: string,
    replacement: LocalInteraction | null,
): readonly LocalInteraction[] {
    const remaining = current.filter((interaction) => interactionId(interaction) !== id);
    return replacement === null ? remaining : [...remaining, replacement];
}

function resolveElicitation(
    current: readonly LocalInteraction[],
    id: string,
    action: "accept" | "cancel" | "complete" | "decline",
): readonly LocalInteraction[] {
    return current.map((interaction): LocalInteraction => {
        if (
            interaction.kind !== "elicitation" ||
            interaction.elicitation.interactionId !== id ||
            interaction.elicitation.state.kind === "resolved"
        ) {
            return interaction;
        }
        return {
            kind: "elicitation",
            elicitation: {
                ...interaction.elicitation,
                state: {
                    action,
                    content:
                        interaction.elicitation.state.kind === "submitted" ? interaction.elicitation.state.content : "",
                    kind: "resolved",
                },
            },
        };
    });
}

function resolvePermission(
    current: readonly LocalInteraction[],
    id: string,
    outcome: PermissionInteractionResponse["outcome"],
    optionId: string,
): readonly LocalInteraction[] {
    return current.map((interaction): LocalInteraction => {
        if (
            interaction.kind !== "permission" ||
            interaction.permission.interactionId !== id ||
            interaction.permission.state.kind === "resolved"
        ) {
            return interaction;
        }
        return {
            kind: "permission",
            permission: {
                ...interaction.permission,
                state: { kind: "resolved", optionId, outcome },
            },
        };
    });
}

export interface SessionPaneStore {
    readonly connection: Connection;
    readonly title: string;
    readonly titleEdit: TitleEdit;
    readonly messages: readonly SessionMessage[];
    readonly historyLoading: boolean;
    readonly historyRevision: number;
    readonly hasOlderHistory: boolean;
    readonly options: readonly SessionConfigOption[];
    readonly draft: string;
    readonly interactions: readonly LocalInteraction[];
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
    /** In-flight response for the interaction cards; a submitted interaction stays answered. */
    readonly interactionOperation:
        | { readonly kind: "idle" }
        | { readonly kind: "submitting"; readonly interactionId: string }
        | { readonly kind: "submitted"; readonly interactionId: string }
        | { readonly kind: "failed"; readonly interactionId: string; readonly message: string };
    readonly operation: Operation;
    readonly activity: SessionActivityState;
    /** Display-only harness list; loading failures leave the current harness. */
    readonly harnesses: readonly { readonly agentRef?: string; readonly label: string; readonly value: string }[];
    readonly connect: (signal: AbortSignal) => Promise<void>;
    readonly retryNow: () => void;
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
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
    /** Submits an interaction response, tracking busy/answered/failed state for the cards. */
    readonly respondToInteraction: (
        interactionId: string,
        response: () => Promise<void>,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
    attachments: ComposerAttachmentStore,
) {
    const needsApproval = model.interactions.some(
        (interaction) => interaction.kind === "permission" && interaction.permission.state.kind === "pending",
    );
    const waitingForInput = model.interactions.some(
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
        composerError:
            connectionFailure(model.connection) ??
            [model.activity, model.operation, delivery.state, tasks.feedback, queue.feedback].find(
                (state) => state.kind === "failed",
            )?.message ??
            "",
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
    readonly requests: Pick<BotChatApi, "connectSession" | "runtimeConfiguration">;
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
    const initialActiveTurn: SessionActiveTurn =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? {
                  commandId: decodeIdentifier(session.result.activeTurn.commandId),
                  kind: "accepted" as const,
                  turnId: decodeIdentifier(session.result.activeTurn.turnId),
              }
            : { kind: "idle" };
    const activeTurn = createSessionActiveTurn({ initial: initialActiveTurn });
    const openedActiveTurn = activeTurn.current();
    const fallbackStartedAt = Date.now();
    let client: MobiusClient | null = null;
    let countdownInterrupt: AbortController | null = null;
    let projection = createSessionProjection();
    let sessionTitle = session.entry.title;
    let loadingOlderHistory = false;
    let command = openedActiveTurn.kind === "idle" ? "" : openedActiveTurn.commandId;
    let initialCommandId = options.initialMessage?.commandId ?? null;
    // The queued first message stays the pane's recovery responsibility until
    // the service accepts it or the user discards it, not just until the send
    // starts.
    const queuedInitialCommandId = options.initialMessage?.commandId ?? options.unconfirmedMessage?.commandId ?? null;
    const isQueuedInitialMessage = (commandId: string): boolean => commandId === queuedInitialCommandId;
    let sessionConfigurations = session.result.ready.configOptions.map((option) => ({
        booleanValue: option.type === "boolean" ? option.booleanValue : false,
        configId: option.id,
        value: option.type === "select" ? option.currentValue : "",
        valueType: option.type,
    }));
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
        submit: async (request, signal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            return await client.turns.submit(
                sessionId,
                withInstructions({
                    ...request,
                    agentId: session.agentRef,
                    directoryId: session.result.ready.directoryId,
                    sessionConfigurations,
                }),
                signal,
            );
        },
        initialUnknown: options.unconfirmedMessage,
    });
    const lastSentMessageEntry = sessionLastSentMessageEntry(sessionId);
    let lastSentMessage: SessionLastSentMessage | null = null;
    let lastSentMessageRevision = 0;
    const initialActivity: SessionActivityState =
        command === "" ? { kind: "idle" } : startSessionWork({ commandId: command, startedAt: fallbackStartedAt });
    const deriveTimeline = (): { readonly messages: readonly SessionMessage[] } => ({
        messages: sessionProjectionMessages(projection),
    });
    const tasks = createSessionTaskControlsStore({
        steeringSupported: session.result.ready.capabilities.steering,
        port: {
            cancel: async (turnId, idempotencyKey, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
            },
            submit: async (request, signal) => {
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
            },
        },
    });
    if (openedActiveTurn.kind === "accepted") {
        tasks.getState().start(openedActiveTurn.commandId, openedActiveTurn.turnId);
    }
    const messageQueue = createSessionMessageQueueStore({
        port: {
            cancel: async (turnId, idempotencyKey, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
            },
            steer: async (turnId, signal) => {
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                await client.turns.steer(sessionId, turnId, signal);
            },
            submit: async (request, signal) => {
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
            },
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

    // Activity transitions are reported to the owner through this latch at
    // the explicit sites that change activity; connection waiters are woken
    // where the connection settles. No wrapped set, no subscriptions.
    let reportedStatus: SessionActivityState | null = null;
    const connectionWaiters = new Set<() => void>();
    const store = createStore<SessionPaneStore>()((set, get) => {
        const settleConnectionWaiters = (): void => {
            const connection = get().connection;
            const settled =
                connection.kind === "ready" ||
                connection.kind === "failed" ||
                (connection.kind === "disconnected" && connection.retry.kind === "exhausted");
            if (settled) {
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
        let historyLoadController: AbortController | null = null;
        const commitProjection = (input: SessionProjectionInput): readonly SessionProjectionEffect[] => {
            const result = transitionSessionProjection(projection, input);
            projection = result.state;
            const pagination = sessionProjectionPagination(projection);
            set({
                hasOlderHistory: pagination !== null,
                historyRevision: projection.revision,
                messages: sessionProjectionMessages(projection),
            });
            for (const effect of result.effects) {
                if (effect.kind !== "adopted") {
                    continue;
                }
                if (effect.config !== undefined) {
                    sessionConfigurations = effect.config.map((candidate) => ({
                        booleanValue: candidate.type === "boolean" ? candidate.booleanValue : false,
                        configId: candidate.id,
                        value: candidate.type === "select" ? candidate.currentValue : "",
                        valueType: candidate.type,
                    }));
                    saveLastAgentSettings(botId, session.agentRef, effect.config);
                    set({ options: effect.config });
                }
                if (effect.title !== undefined) {
                    sessionTitle = effect.title;
                    set({ title: sessionTitle });
                    options.onTitleChange(sessionId, sessionTitle);
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
            for (const effect of effects) {
                if (effect.kind === "load-history") {
                    await loadProjectionHistory(effect, connected, signal);
                }
            }
        };
        return {
            connection: { kind: "loading" },
            title: sessionTitle,
            titleEdit: { kind: "closed" },
            messages: initialTimeline.messages,
            historyLoading: false,
            historyRevision: 0,
            hasOlderHistory: false,
            options: session.result.ready.configOptions,
            draft: options.initialMessage?.content ?? centralSessionStorage.read(draftEntry) ?? "",
            harnesses: [{ agentRef: session.agentRef, label: session.agentRef, value: session.agentRef }],
            interactions: [],
            followRevision: 0,
            interactionOperation: { kind: "idle" },
            operation: { kind: "idle" },
            activity: initialActivity,
            loadOlderMessages: async (signal) => {
                const pagination = sessionProjectionPagination(projection);
                if (loadingOlderHistory || pagination === null || client === null) {
                    return;
                }
                loadingOlderHistory = true;
                set({ historyLoading: true });
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
                    const revision = lastSentMessageRevision;
                    void centralIndexedDB.get(lastSentMessageEntry, signal).then((stored) => {
                        if (stored === null || revision !== lastSentMessageRevision) {
                            return;
                        }
                        lastSentMessage = stored;
                        const current = get().activity;
                        if (current.kind === "working" && current.commandId === stored.commandId) {
                            set({
                                activity: startSessionWork({
                                    commandId: current.commandId,
                                    startedAt: stored.sentAt,
                                }),
                            });
                            announceActivity();
                        }
                    });
                };
                let consecutiveFailures = 0;
                const observeSession = async (): Promise<void> => {
                    client = await requests.connectSession(
                        botId,
                        sessionId,
                        signal,
                        session.result.action === "conversation" ? session.result.access : undefined,
                    );
                    const connected = client;
                    const receiveLifecycle = async (
                        payload: Extract<SessionEvent, { readonly type: "lifecycle-metadata" }>["payload"],
                    ): Promise<boolean> => {
                        if ("event" in payload) {
                            const event = payload.event;
                            if (event.kind === "session.permission.requested") {
                                set((current) => ({
                                    interactions: replaceInteraction(current.interactions, event.interactionId, {
                                        kind: "permission",
                                        permission: { ...event, state: { kind: "pending" } },
                                    }),
                                }));
                                return true;
                            }
                            if (event.kind === "session.permission.resolved") {
                                set((current) => ({
                                    interactions: resolvePermission(
                                        current.interactions,
                                        event.interactionId,
                                        event.outcome,
                                        event.optionId,
                                    ),
                                }));
                                return true;
                            }
                            if (event.kind === "session.elicitation.requested") {
                                const { accepted, ...elicitation } = event;
                                set((current) => ({
                                    interactions: replaceInteraction(current.interactions, event.interactionId, {
                                        kind: "elicitation",
                                        elicitation: {
                                            ...elicitation,
                                            state: accepted
                                                ? { action: "accept", content: "", kind: "submitted" }
                                                : { kind: "pending" },
                                        },
                                    }),
                                }));
                                return true;
                            }
                            if (event.kind === "session.elicitation.resolved") {
                                set((current) => ({
                                    interactions: resolveElicitation(
                                        current.interactions,
                                        event.interactionId,
                                        event.action,
                                    ),
                                }));
                                return true;
                            }

                            return true;
                        }
                        if (payload.kind === "session.queue.changed") {
                            const execution = await connected.sessions.readSessionExecution(
                                sessionId,
                                sessionIdentity,
                                signal,
                            );
                            signal.throwIfAborted();
                            messageQueue.getState().replace(execution.queued);
                            return true;
                        }
                        if (payload.kind === "prompt.started") {
                            delivery.getState().reconcile([payload.commandId]);
                            const queued = messageQueue.getState().takeStarted(payload.commandId);
                            const owner = sessionProjectionExecutionOwner(projection, payload.commandId);
                            if (owner !== null && owner !== payload.commandId) {
                                // Steering starts a command, not a new execution to stop.
                                return true;
                            }
                            if (command !== "" && command !== payload.commandId) {
                                tasks.getState().finish(command);
                                activeTurn.turnCleared(command);
                            }
                            command = payload.commandId;
                            const accepted = activeTurn.current();
                            const turnId =
                                queued?.turnId ??
                                (accepted.kind === "accepted" && accepted.commandId === payload.commandId
                                    ? accepted.turnId
                                    : payload.commandId);
                            tasks.getState().start(payload.commandId, turnId);
                            activeTurn.submissionAccepted(payload.commandId, turnId);
                            const currentActivity = get().activity;
                            const startedAt =
                                currentActivity.kind === "working" && currentActivity.commandId === payload.commandId
                                    ? currentActivity.startedAt
                                    : lastSentMessage?.commandId === payload.commandId
                                      ? lastSentMessage.sentAt
                                      : Date.now();
                            set({ activity: startSessionWork({ commandId: payload.commandId, startedAt }) });
                            announceActivity();
                            return true;
                        }
                        if (
                            payload.kind === "prompt.completed" ||
                            payload.kind === "prompt.failed" ||
                            payload.kind === "prompt.failed-before-start"
                        ) {
                            delivery.getState().reconcile([payload.commandId]);
                            if (payload.kind === "prompt.completed" && payload.stopReason === "steered") {
                                const execution = await connected.sessions.readSessionExecution(
                                    sessionId,
                                    sessionIdentity,
                                    signal,
                                );
                                signal.throwIfAborted();
                                const running = execution.turn;
                                if (running !== null) {
                                    command = running.commandId;
                                    tasks.getState().start(running.commandId, running.commandId);
                                    activeTurn.submissionAccepted(running.commandId, running.commandId);
                                    const timeline = deriveTimeline();
                                    set({
                                        activity: startSessionWork({
                                            commandId: running.commandId,
                                            startedAt:
                                                lastSentMessage?.commandId === running.commandId
                                                    ? lastSentMessage.sentAt
                                                    : Date.now(),
                                        }),
                                        messages: timeline.messages,
                                        operation: finishPromptOperation(get().operation, payload.commandId),
                                    });
                                    announceActivity();
                                    return true;
                                }
                            }
                            const activity = transitionSessionActivity(
                                get().activity,
                                payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start"
                                    ? {
                                          commandId: payload.commandId,
                                          kind: "work-failed",
                                          message: payload.message,
                                      }
                                    : { commandId: payload.commandId, kind: "work-completed" },
                            );
                            const completed = deriveTimeline();
                            set({
                                activity,
                                messages: completed.messages,
                                operation: finishPromptOperation(get().operation, payload.commandId),
                            });
                            announceActivity();
                            tasks.getState().finish(payload.commandId);
                            activeTurn.turnCleared(payload.commandId);
                            if (command === payload.commandId) {
                                command = "";
                            }
                        }
                        return true;
                    };
                    const observer: MobiusSessionEventObserver = {
                        reconcile: async (connection) => {
                            const reconcilingTurn = activeTurn.current();
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
                                command = running.commandId;
                                const turnId =
                                    reconciliation.turn.kind === "accepted" &&
                                    reconciliation.turn.commandId === running.commandId
                                        ? reconciliation.turn.turnId
                                        : running.commandId;
                                tasks.getState().start(running.commandId, turnId);
                                activeTurn.submissionAccepted(running.commandId, turnId);
                            } else if (reconciliation.turn.kind !== "idle") {
                                tasks.getState().finish(reconciliation.turn.commandId);
                                activeTurn.turnCleared(reconciliation.turn.commandId);
                                command = "";
                            }
                            const currentActivity = get().activity;
                            let restoredActivity: SessionActivityState;
                            if (command === "") {
                                // Restoring the connection cannot resolve an independent turn failure.
                                restoredActivity =
                                    currentActivity.kind === "failed" ? currentActivity : { kind: "idle" };
                            } else if (currentActivity.kind === "working" && currentActivity.commandId === command) {
                                restoredActivity = currentActivity;
                            } else {
                                restoredActivity = startSessionWork({
                                    commandId: command,
                                    startedAt:
                                        lastSentMessage?.commandId === command ? lastSentMessage.sentAt : Date.now(),
                                });
                            }
                            signal.throwIfAborted();
                            const interactions: readonly LocalInteraction[] = (() => {
                                const interaction = execution.turn?.interaction;
                                if (interaction === undefined || interaction === null) {
                                    return [];
                                }
                                if (interaction.kind === "session.permission.requested") {
                                    return [
                                        {
                                            kind: "permission",
                                            permission: { ...interaction, state: { kind: "pending" } },
                                        },
                                    ];
                                }
                                const { accepted, ...elicitation } = interaction;
                                return [
                                    {
                                        kind: "elicitation",
                                        elicitation: {
                                            ...elicitation,
                                            state: accepted
                                                ? { action: "accept", content: "", kind: "submitted" }
                                                : { kind: "pending" },
                                        },
                                    },
                                ];
                            })();
                            set({
                                interactions,
                                activity: restoredActivity,
                            });
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
                                    await receiveLifecycle(event.payload);
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
                    if (initialCommandId !== null) {
                        // Send reports delivery itself, so an uncertain or
                        // rejected submission leaves the queued message and its
                        // idempotent command id in the home store for a remount
                        // to recover.
                        await get().send(signal);
                        signal.throwIfAborted();
                    }
                    // A detach between submit and the delivery report can still
                    // re-send the queued message on re-attach. That is safe:
                    // the command id is the turn submit's idempotency key, so
                    // the service deduplicates the repeated submission.
                    await subscription.completed;
                    signal.throwIfAborted();
                    throw new Error("Session updates disconnected. Reopen the Session to continue.");
                };
                readStoredLastSentMessage();
                for (;;) {
                    if (consecutiveFailures > 0) {
                        setAndSettle({
                            connection: { kind: "reconnecting", message: connectionFailure(get().connection) },
                        });
                    }
                    try {
                        await observeSession();
                    } catch (cause) {
                        client?.close();
                        client = null;
                        if (signal.aborted) {
                            return;
                        }
                        if (!isRetryableRuntimeConnectionFailure(cause)) {
                            const message = formatError(cause, "The Session could not be opened.");
                            setAndSettle({
                                connection: { kind: "failed", message },
                            });
                            return;
                        }
                        const canAutoRetry = consecutiveFailures < SESSION_AUTO_RECONNECT_ATTEMPTS;
                        const delay = Math.min(
                            SESSION_RECONNECT_DELAYS_MS[consecutiveFailures] ?? SESSION_RECONNECT_DELAY_CAP_MS,
                            SESSION_RECONNECT_DELAY_CAP_MS,
                        );
                        consecutiveFailures += 1;
                        const message = formatError(cause, "The Session could not be opened.");
                        const remainingSeconds = Math.ceil(delay / 1000);
                        setAndSettle({
                            connection: {
                                kind: "disconnected",
                                message,
                                retry: canAutoRetry ? { kind: "scheduled", remainingSeconds } : { kind: "exhausted" },
                            },
                        });
                        countdownInterrupt = new AbortController();
                        const retrySignal = AbortSignal.any([signal, countdownInterrupt.signal]);
                        try {
                            if (canAutoRetry) {
                                const retryAt = clock.now() + delay;
                                while (clock.now() < retryAt) {
                                    await clock.sleep(Math.min(1000, retryAt - clock.now()), retrySignal);
                                    retrySignal.throwIfAborted();
                                    setAndSettle({
                                        connection: {
                                            kind: "disconnected",
                                            message,
                                            retry: {
                                                kind: "scheduled",
                                                remainingSeconds: Math.ceil((retryAt - clock.now()) / 1000),
                                            },
                                        },
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
            setDraft: (draft) => {
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
                const commandId = initialCommandId ?? crypto.randomUUID();
                initialCommandId = null;
                command = commandId;
                lastSentMessageRevision += 1;
                lastSentMessage = { commandId, sentAt: Date.now() };
                void centralIndexedDB.set(lastSentMessageEntry, lastSentMessage, signal);
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
                centralSessionStorage.remove(draftEntry);
                composerAttachments.getState().clear();
                const activity = startSessionWork({ commandId, startedAt: lastSentMessage.sentAt });
                const pending = deriveTimeline();
                set({
                    activity,
                    draft: "",
                    followRevision: get().followRevision + 1,
                    operation: { kind: "sending", commandId },
                    messages: pending.messages,
                });
                try {
                    activeTurn.submissionStarted(commandId);
                    const submission = {
                        ...request,
                        content: prompt,
                        images,
                        resources: attachments.flatMap((attachment) =>
                            attachment.kind === "resource" ? [attachment.resource] : [],
                        ),
                    };
                    const accepted = await delivery.getState().submit(commandId, displayPrompt, submission, signal);
                    signal.throwIfAborted();
                    // Report delivery as soon as the service accepts the turn,
                    // independently of `command`: a live event may clear it
                    // while the submission is in flight. An uncertain
                    // (delivery-unknown) or rejected submission marks the
                    // queued first message as unconfirmed, which keeps its
                    // content and command id for an explicit retry but never
                    // auto-sends it from a remount.
                    if (accepted !== null) {
                        if (isQueuedInitialMessage(commandId)) {
                            options.onInitialMessageDelivered?.();
                        }
                    } else if (isQueuedInitialMessage(commandId)) {
                        options.onInitialMessageUnconfirmed?.({ commandId, displayPrompt, request: submission });
                    }
                    if (accepted !== null) {
                        // A terminal live event may precede the acceptance response.
                        // Its result already owns the activity; do not overwrite it.
                        if (command === commandId) {
                            tasks.getState().start(commandId, accepted.turnId);
                            activeTurn.submissionAccepted(commandId, accepted.turnId);
                        }
                        set({ operation: finishPromptOperation(get().operation, commandId) });
                        return;
                    }
                    activeTurn.turnCleared(commandId);
                    command = "";
                    const idle = { kind: "idle" } as const;
                    const restored = deriveTimeline();
                    set({
                        activity: idle,
                        messages: restored.messages,
                        operation: { kind: "idle" },
                    });
                    announceActivity();
                } catch (cause) {
                    signal.throwIfAborted();
                    set((current) => ({
                        activity: transitionSessionActivity(current.activity, {
                            commandId,
                            kind: "work-failed",
                            message: formatError(cause, "The agent could not complete the message."),
                        }),
                        operation: {
                            kind: "failed",
                            message: formatError(cause, "The agent could not complete the message."),
                        },
                    }));
                    announceActivity();
                }
            },
            removeUnknownDelivery: () => {
                const commandId = delivery.getState().discardUnknown();
                if (commandId === null) {
                    return;
                }
                if (command === commandId) {
                    activeTurn.turnCleared(commandId);
                    command = "";
                }
                // Mirrors the delivery report: dropping this pane's retry path
                // must also drop the home store's recovery copy, or a remount
                // would submit the message the user just discarded.
                if (isQueuedInitialMessage(commandId)) {
                    options.onInitialMessageRecoveryCleared?.(commandId);
                }
                const activity = transitionSessionActivity(get().activity, { commandId, kind: "work-completed" });
                const restored = deriveTimeline();
                set({ activity, messages: restored.messages });
                announceActivity();
            },
            retryUnknownDelivery: async (signal) => {
                const state = delivery.getState().state;
                if (get().connection.kind !== "ready" || state.kind !== "delivery-unknown") {
                    return;
                }
                const pending = state.journal;
                command = pending.commandId;
                const retrying = startSessionWork({
                    commandId: pending.commandId,
                    startedAt: lastSentMessage?.commandId === pending.commandId ? lastSentMessage.sentAt : Date.now(),
                });
                const retried = deriveTimeline();
                set({ activity: retrying, messages: retried.messages });
                announceActivity();
                const accepted = await delivery.getState().retry(signal);
                signal.throwIfAborted();
                if (accepted !== null) {
                    // A successful retry also delivers the queued first
                    // message, so the home store must stop treating it as
                    // pending recovery.
                    if (isQueuedInitialMessage(pending.commandId)) {
                        options.onInitialMessageDelivered?.();
                    }
                    tasks.getState().start(pending.commandId, accepted.turnId);
                    activeTurn.submissionAccepted(pending.commandId, accepted.turnId);
                } else {
                    activeTurn.turnCleared(pending.commandId);
                    command = "";
                }
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
                    lastSentMessageRevision += 1;
                    lastSentMessage = { commandId: queued.commandId, sentAt: Date.now() };
                    void centralIndexedDB.set(lastSentMessageEntry, lastSentMessage, signal);
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
                    sessionConfigurations = result.configOptions.map((candidate) => ({
                        booleanValue: candidate.type === "boolean" ? candidate.booleanValue : false,
                        configId: candidate.id,
                        value: candidate.type === "select" ? candidate.currentValue : "",
                        valueType: candidate.type,
                    }));
                    saveLastAgentSettings(botId, session.agentRef, result.configOptions);
                    set({ options: result.configOptions, operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
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
                    trimmed === sessionTitle ||
                    client === null ||
                    get().connection.kind !== "ready"
                ) {
                    set({ titleEdit: { kind: "closed" } });
                    return;
                }
                set({ titleEdit: { draft: trimmed, kind: "saving" } });
                try {
                    const result = await client.sessions.rename(
                        sessionId,
                        trimmed,
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    sessionTitle = result.title;
                    set({ title: sessionTitle, titleEdit: { kind: "closed" } });
                    options.onTitleChange(sessionId, sessionTitle);
                } catch (cause) {
                    signal.throwIfAborted();
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
                try {
                    const connected = client;
                    await dispatchProjection({ kind: "reconcile" }, connected, signal);
                    signal.throwIfAborted();
                    set({ operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        operation: {
                            kind: "failed",
                            message: formatError(cause, "The settings could not be reloaded."),
                        },
                    });
                }
            },
            respondToPermission: async (response, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    throw new Error("The Session is not connected.");
                }
                try {
                    await client.interactions.respond(
                        sessionId,
                        response.interactionId,
                        new MobiusPermissionResponseRequest("mobius-web", response.outcome, response.optionId),
                        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                    );
                } catch (cause) {
                    signal.throwIfAborted();
                    throw cause;
                }
            },
            respondToElicitation: async (response, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    throw new Error("The Session is not connected.");
                }
                try {
                    await client.interactions.respond(
                        sessionId,
                        response.interactionId,
                        new MobiusElicitationResponseRequest("mobius-web", response.action, response.content),
                        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                    );
                } catch (cause) {
                    signal.throwIfAborted();
                    throw cause;
                }
            },
            respondToInteraction: async (interactionId, response, signal) => {
                const current = get().interactionOperation;
                if (
                    current.kind === "submitting" ||
                    (current.kind === "submitted" && current.interactionId === interactionId)
                ) {
                    return;
                }
                set({ interactionOperation: { kind: "submitting", interactionId } });
                try {
                    await response();
                    if (!signal.aborted) {
                        set({ interactionOperation: { kind: "submitted", interactionId } });
                    }
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        interactionOperation: {
                            kind: "failed",
                            interactionId,
                            message: formatError(cause, "The response could not be submitted."),
                        },
                    });
                }
            },
            stop: async (signal) => await tasks.getState().stop(signal),
        };
    });
    const interactionSubmissions = createSessionInteractionStore({
        permission: (response, signal) => store.getState().respondToPermission(response, signal),
        elicitation: (response, signal) => store.getState().respondToElicitation(response, signal),
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
                    harnesses: connectedChatRuntimeAgents(configuration.runtime).map((agent) => ({
                        agentRef: agent.agentRef,
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
        interactionSubmissions,
        store,
        delivery,
        filePreview,
        messageQueue,
        tasks,
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
