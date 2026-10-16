import { decodeIdentifier, type SessionEventV2 } from "@moxt-ai/mobius-protocol";
import {
    type MobiusClient,
    MobiusElicitationResponseRequest,
    type MobiusLiveSessionEventObserverV2,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import {
    centralIndexedDB,
    type SessionLastSentMessage,
    sessionLastSentMessageEntry,
} from "../../services/indexed-db/central-indexed-db.ts";
import { centralSessionStorage, sessionDraftEntry } from "../../services/session-storage/central-session-storage.ts";
import { formatError } from "../format-error.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import type { QueuedDraftMessage } from "./conversation-creation-machine.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { createSessionActiveTurn, type SessionActiveTurn } from "./session-active-turn.ts";
import {
    type SessionActivityState,
    startSessionWork,
    transitionSessionActivity,
    workingCommandId,
} from "./session-activity-machine.ts";
import { createSessionDeliveryStore, type SessionDeliveryStore } from "./session-delivery-store.ts";
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
    sessionProjectionMessages,
    sessionProjectionPagination,
    transitionSessionProjection,
} from "./session-projection.ts";
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";

type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };
type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string };
type Connection =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly client: MobiusClient }
    | { readonly kind: "failed"; readonly message: string };
type LocalInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;

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
    readonly attachments: readonly ComposerAttachment[];
    readonly interactions: readonly LocalInteraction[];
    readonly operation: Operation;
    readonly activity: SessionActivityState;
    readonly connect: (signal: AbortSignal) => Promise<void>;
    readonly loadOlderMessages: (signal: AbortSignal) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly setAttachments: (attachments: readonly ComposerAttachment[]) => void;
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
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
) {
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
    return {
        activeMessageId,
        activeCommandId,
        busy,
        composerDisabled,
        composerError:
            model.activity.kind === "failed"
                ? model.activity.message
                : model.operation.kind === "failed"
                  ? model.operation.message
                  : delivery.state.kind === "failed"
                    ? delivery.state.message
                    : tasks.feedback.kind === "failed"
                      ? tasks.feedback.message
                      : queue.feedback.kind === "failed"
                        ? queue.feedback.message
                        : "",
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
            activeCommandId !== null &&
            model.messages.some((message) => message.role === "user" && message.commandId === activeCommandId),
        shouldQueueOnSubmit: tasks.operation.kind === "running",
        submitDisabled:
            (tasks.operation.kind === "running" ? queue.operation.kind !== "idle" : busy) ||
            (model.draft.trim() === "" && model.attachments.length === 0),
    } as const;
}

interface SessionIdentity {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
}

async function readSessionHistoryV2(
    client: MobiusClient,
    sessionId: string,
    initialCursor: string | null,
    newerEvents: readonly SessionEventV2[],
    expectedSessionGenerationId: string | null,
    signal: AbortSignal,
): Promise<SessionEventHistory> {
    let events: readonly SessionEventV2[] = newerEvents;
    let nextCursor = initialCursor;
    let sessionGenerationId = expectedSessionGenerationId;
    let renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    do {
        const requestedCursor = nextCursor;
        const page = await client.events.listV2(
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
    current: readonly SessionEventV2[],
    incoming: readonly SessionEventV2[],
): readonly SessionEventV2[] {
    const byId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
        byId.set(event.eventId, event);
    }
    return [...byId.values()];
}

export function createSessionPaneModel(options: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly initialMessage?: QueuedDraftMessage | undefined;
    readonly onTitleChange: (sessionId: string, title: string) => void;
}) {
    const { session, botId, requests } = options;
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
    let projection = createSessionProjection();
    let sessionTitle = session.entry.title;
    let loadingOlderHistory = false;
    let command = openedActiveTurn.kind === "idle" ? "" : openedActiveTurn.commandId;
    let initialCommandId = options.initialMessage?.commandId ?? null;
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
                          name: "Machine instructions",
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

    const store = createStore<SessionPaneStore>()((set, get) => {
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
                const history = await readSessionHistoryV2(
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
            attachments: options.initialMessage?.attachments ?? [],
            interactions: [],
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
                    const page = await readSessionHistoryV2(
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
                try {
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
                        }
                    });
                    client = await requests.connectSession(
                        botId,
                        sessionId,
                        signal,
                        session.result.action === "conversation" ? session.result.access : undefined,
                    );
                    const connected = client;
                    const receiveLifecycle = async (
                        payload: Extract<SessionEventV2, { readonly type: "lifecycle-metadata" }>["payload"],
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
                                        operation: { kind: "idle" },
                                    });
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
                            set({ activity, messages: completed.messages, operation: { kind: "idle" } });
                            tasks.getState().finish(payload.commandId);
                            activeTurn.turnCleared(payload.commandId);
                            if (command === payload.commandId) {
                                command = "";
                            }
                        }
                        return true;
                    };
                    const observer: MobiusLiveSessionEventObserverV2 = {
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
                                    set({ connection: { kind: "loading" } });
                                    break;
                            }
                            const executionPromise = connected.sessions.readSessionExecution(
                                sessionId,
                                sessionIdentity,
                                signal,
                            );
                            // Reconciliation may abandon this speculative read when the
                            // subscription tears down; keep its aborted rejection awaited.
                            void executionPromise.then(
                                () => undefined,
                                () => undefined,
                            );
                            await dispatchProjection({ kind: "reconcile" }, connected, signal);
                            signal.throwIfAborted();
                            const execution = await executionPromise;
                            const running = execution.turn;
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
                            const restoredActivity =
                                command === ""
                                    ? ({ kind: "idle" } as const)
                                    : currentActivity.kind === "working" && currentActivity.commandId === command
                                      ? currentActivity
                                      : startSessionWork({
                                            commandId: command,
                                            startedAt:
                                                lastSentMessage?.commandId === command
                                                    ? lastSentMessage.sentAt
                                                    : Date.now(),
                                        });
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
                            switch (reconciliation.kind) {
                                case "initial-subscription":
                                    break;
                                case "reconnecting":
                                    set({ connection: { client: connected, kind: "ready" } });
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
                    const subscription = await connected.events.subscribeLiveV2(sessionId, observer, signal);
                    signal.throwIfAborted();
                    set({ connection: { kind: "ready", client: connected } });
                    if (initialCommandId !== null) {
                        await get().send(signal);
                        signal.throwIfAborted();
                    }
                    await subscription.completed;
                    signal.throwIfAborted();
                    throw new Error("Session updates disconnected. Reopen the Session to continue.");
                } catch (cause) {
                    client?.close();
                    client = null;
                    if (!signal.aborted) {
                        const message = formatError(cause, "The Session could not be opened.");
                        set({
                            connection: { kind: "failed", message },
                            activity: transitionSessionActivity(get().activity, {
                                kind: "session-failed",
                                message,
                            }),
                            operation: {
                                kind: "failed",
                                message,
                            },
                        });
                    }
                }
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
            setAttachments: (attachments) => set({ attachments }),
            send: async (signal) => {
                const current = get();
                if (
                    current.connection.kind !== "ready" ||
                    (current.draft.trim() === "" && current.attachments.length === 0) ||
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
                    current.attachments
                        .map((attachment) =>
                            attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                        )
                        .join(", ");
                const images = current.attachments.flatMap((attachment) =>
                    attachment.kind === "image" ? [attachment.image] : [],
                );
                centralSessionStorage.remove(draftEntry);
                const activity = startSessionWork({ commandId, startedAt: lastSentMessage.sentAt });
                const pending = deriveTimeline();
                set({
                    activity,
                    draft: "",
                    attachments: [],
                    operation: { kind: "sending", commandId },
                    messages: pending.messages,
                });
                try {
                    activeTurn.submissionStarted(commandId);
                    const accepted = await delivery.getState().submit(
                        commandId,
                        displayPrompt,
                        {
                            ...request,
                            content: prompt,
                            images,
                            resources: current.attachments.flatMap((attachment) =>
                                attachment.kind === "resource" ? [attachment.resource] : [],
                            ),
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    if (accepted !== null && command === commandId) {
                        tasks.getState().start(commandId, accepted.turnId);
                        activeTurn.submissionAccepted(commandId, accepted.turnId);
                        set({ operation: { kind: "idle" } });
                    } else {
                        activeTurn.turnCleared(commandId);
                        command = "";
                        const idle = { kind: "idle" } as const;
                        const restored = deriveTimeline();
                        set({
                            activity: idle,
                            messages: restored.messages,
                            operation: { kind: "idle" },
                        });
                    }
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
                const activity = transitionSessionActivity(get().activity, { commandId, kind: "work-completed" });
                const restored = deriveTimeline();
                set({ activity, messages: restored.messages });
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
                const accepted = await delivery.getState().retry(signal);
                signal.throwIfAborted();
                if (accepted !== null) {
                    tasks.getState().start(pending.commandId, accepted.turnId);
                    activeTurn.submissionAccepted(pending.commandId, accepted.turnId);
                } else {
                    activeTurn.turnCleared(pending.commandId);
                    command = "";
                }
            },
            queueDraft: async (signal) => {
                const current = get();
                const controls = tasks.getState();
                if (current.connection.kind !== "ready" || controls.operation.kind !== "running") {
                    return;
                }
                const prompt = current.draft.trim();
                const summary =
                    prompt ||
                    current.attachments
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
                        images: current.attachments.flatMap((attachment) =>
                            attachment.kind === "image" ? [attachment.image] : [],
                        ),
                        resources: current.attachments.flatMap((attachment) =>
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
                    set({ draft: "", attachments: [] });
                }
            },
            steerQueued: async (commandId, signal) => {
                const steered = await messageQueue.getState().steerMessage(commandId, signal);
                signal.throwIfAborted();
                if (steered !== null) {
                    const timeline = deriveTimeline();
                    set({ messages: timeline.messages });
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
            stop: async (signal) => await tasks.getState().stop(signal),
        };
    });
    return {
        store,
        delivery,
        messageQueue,
        tasks,
        readFile: async (path: string, signal: AbortSignal) => {
            signal.throwIfAborted();
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            return await client.sessions.readFile(
                sessionId,
                path,
                AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                32 * 1024 * 1024,
            );
        },
    };
}
