import {
    decodeIdentifier,
    type SessionHistoryMessageV3,
    type SessionLiveEventItemV3,
    type SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";
import type {
    MobiusClient,
    MobiusLiveSessionEventObserverV3,
    PromptResource,
    SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import {
    centralIndexedDB,
    type SessionLastSentMessage,
    sessionLastSentMessageEntry,
} from "../../services/indexed-db/central-indexed-db.ts";
import { centralLocalStorage, sessionDraftEntry } from "../../services/local-storage/central-local-storage.ts";
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
import type { SessionMessage } from "./session-presentation.ts";
import {
    createSessionProjection,
    type SessionEventHistory,
    type SessionProjectionEffect,
    type SessionProjectionInput,
    sessionProjectionMessages,
    sessionProjectionPagination,
    sessionSettingsOptions,
    transitionSessionProjection,
} from "./session-projection.ts";
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";

type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };
type Connection =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly client: MobiusClient }
    | { readonly kind: "failed"; readonly message: string };
type LocalInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

const SESSION_EVENT_PAGE_LIMIT = 500;
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

function userInputValues(content: string): SessionUserInputResponseV3["values"] {
    let decoded: unknown;
    try {
        decoded = JSON.parse(content);
    } catch (cause) {
        throw new Error("The user input response is not valid JSON.", { cause });
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("The user input response must contain named values.");
    }
    const values: Record<string, string | number | boolean | readonly string[]> = {};
    for (const [name, value] of Object.entries(decoded)) {
        if (
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))
        ) {
            values[name] = value;
            continue;
        }
        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
            values[name] = value;
            continue;
        }
        throw new Error(`The user input value '${name}' is invalid.`);
    }
    return values;
}

export interface SessionPaneStore {
    readonly connection: Connection;
    readonly title: string;
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

async function readSessionHistoryV3(
    client: MobiusClient,
    sessionId: string,
    initialCursor: string | null,
    signal: AbortSignal,
): Promise<SessionEventHistory> {
    let messages: readonly SessionHistoryMessageV3[] = [];
    let nextCursor = initialCursor;
    let throughSeq: number | null = null;
    do {
        const requestedCursor = nextCursor;
        const page = await client.sessions.loadSessionNativeMessagesV3(
            sessionId,
            { cursor: requestedCursor, messageLimit: SESSION_EVENT_PAGE_LIMIT },
            signal,
        );
        signal.throwIfAborted();
        if (requestedCursor !== null && page.nextCursor === requestedCursor) {
            throw new Error("The Runtime returned the same message-history cursor twice.");
        }
        throughSeq ??= page.throughSeq;
        messages = [...page.messages, ...messages];
        nextCursor = page.nextCursor;
    } while (nextCursor !== null && messages.length < HISTORY_MESSAGE_TARGET);
    if (throughSeq === null) {
        throw new Error("The Runtime returned no Session history watermark.");
    }
    return { messages, nextCursor, throughSeq };
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
    const sessionConfigurations: readonly [] = [];
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
            _effect: Extract<SessionProjectionEffect, { readonly kind: "load-history" }>,
            connected: MobiusClient,
            parentSignal: AbortSignal,
        ): Promise<void> => {
            historyLoadController?.abort();
            const controller = new AbortController();
            historyLoadController = controller;
            const revision = projection.revision;
            try {
                const history = await readSessionHistoryV3(
                    connected,
                    sessionId,
                    null,
                    AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]),
                );
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || projection.pending === null || projection.revision !== revision) {
                    return;
                }
                const effects = commitProjection({ history, kind: "history-loaded", revision });
                for (const effect of effects) {
                    if (effect.kind === "load-history") {
                        await loadProjectionHistory(effect, connected, parentSignal);
                    }
                }
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
            messages: initialTimeline.messages,
            historyLoading: false,
            historyRevision: 0,
            hasOlderHistory: false,
            options: session.result.ready.configOptions,
            draft: options.initialMessage?.content ?? centralLocalStorage.read(draftEntry) ?? "",
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
                    const page = await readSessionHistoryV3(client, sessionId, pagination.nextCursor, signal);
                    signal.throwIfAborted();
                    commitProjection({ kind: "older-page", page, revision: pagination.revision });
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        operation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "Older messages could not be loaded.",
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
                    const receiveLiveItem = async (item: SessionLiveEventItemV3): Promise<void> => {
                        if (item.sessionUpdate === "permission_requested") {
                            set((current) => ({
                                interactions: replaceInteraction(current.interactions, item.requestId, {
                                    kind: "permission",
                                    permission: {
                                        interactionId: item.requestId,
                                        options: item.options,
                                        sessionId,
                                        state: { kind: "pending" },
                                        title: item.title,
                                        toolCallId: item.toolCallId,
                                        toolKind: "other",
                                    },
                                }),
                            }));
                            return;
                        }
                        if (item.sessionUpdate === "permission_resolved") {
                            set((current) => ({
                                interactions: resolvePermission(
                                    current.interactions,
                                    item.requestId,
                                    item.outcome === "selected" ? "selected" : "cancelled",
                                    item.selectedOptionId ?? "",
                                ),
                            }));
                            return;
                        }
                        if (item.sessionUpdate === "user_input_requested") {
                            set((current) => ({
                                interactions: replaceInteraction(current.interactions, item.requestId, {
                                    elicitation: {
                                        fields: item.fields.map((field) => ({
                                            defaultBooleanValue: false,
                                            defaultNumberValue: 0,
                                            defaultStringValue: "",
                                            description: field.description ?? "",
                                            format: "",
                                            hasDefaultValue: false,
                                            maximum: "",
                                            maximumLength: "",
                                            minimum: "",
                                            minimumLength: "",
                                            name: field.name,
                                            options: (field.options ?? []).map((option) => ({
                                                description: option.description ?? "",
                                                label: option.label,
                                                value: option.value,
                                            })),
                                            pattern: "",
                                            required: field.required,
                                            title: field.title,
                                            type: field.type === "text" ? "string" : field.type,
                                        })),
                                        interactionId: item.requestId,
                                        message: item.message,
                                        mode: "form",
                                        sessionId,
                                        state: { kind: "pending" },
                                        url: "",
                                    },
                                    kind: "elicitation",
                                }),
                            }));
                            return;
                        }
                        if (item.sessionUpdate === "user_input_resolved") {
                            set((current) => ({
                                interactions: resolveElicitation(
                                    current.interactions,
                                    item.requestId,
                                    item.outcome === "submitted" ? "accept" : "cancel",
                                ),
                            }));
                            return;
                        }
                        if (item.sessionUpdate !== "session_lifecycle_changed") {
                            return;
                        }
                        if (item.state.kind === "running") {
                            const accepted = activeTurn.current();
                            if (accepted.kind !== "accepted") {
                                return;
                            }
                            command = accepted.commandId;
                            tasks.getState().start(accepted.commandId, accepted.turnId);
                            const currentActivity = get().activity;
                            set({
                                activity: startSessionWork({
                                    commandId: accepted.commandId,
                                    startedAt:
                                        currentActivity.kind === "working" &&
                                        currentActivity.commandId === accepted.commandId
                                            ? currentActivity.startedAt
                                            : (lastSentMessage?.sentAt ?? Date.now()),
                                }),
                            });
                            return;
                        }
                        if (item.state.kind !== "idle" && item.state.kind !== "failed") {
                            return;
                        }
                        const completedCommand = command;
                        if (completedCommand === "") {
                            return;
                        }
                        const activity = transitionSessionActivity(
                            get().activity,
                            item.state.kind === "failed"
                                ? { commandId: completedCommand, kind: "work-failed", message: item.state.code }
                                : { commandId: completedCommand, kind: "work-completed" },
                        );
                        set({ activity, operation: { kind: "idle" } });
                        tasks.getState().finish(completedCommand);
                        activeTurn.turnCleared(completedCommand);
                        command = "";
                    };
                    const observer: MobiusLiveSessionEventObserverV3 = {
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
                                await receiveLiveItem(event.item);
                                await new Promise<void>((resolve) => queueMicrotask(resolve));
                                signal.throwIfAborted();
                            }
                            await Promise.all(historyLoads);
                            return true;
                        },
                    };
                    const subscription = await connected.events.subscribeLiveV3(sessionId, observer, signal);
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
                        const message = cause instanceof Error ? cause.message : "The Session could not be opened.";
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
                    centralLocalStorage.remove(draftEntry);
                } else {
                    centralLocalStorage.write(draftEntry, draft);
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
                centralLocalStorage.remove(draftEntry);
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
                            message:
                                cause instanceof Error ? cause.message : "The agent could not complete the message.",
                        }),
                        operation: {
                            kind: "failed",
                            message:
                                cause instanceof Error ? cause.message : "The agent could not complete the message.",
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
                    centralLocalStorage.remove(draftEntry);
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
                    const settings = await client.sessions.changeSessionSettingV3(
                        sessionId,
                        option.id,
                        option.type === "boolean" ? booleanValue : value,
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    const configOptions = sessionSettingsOptions(settings);
                    saveLastAgentSettings(botId, session.agentRef, configOptions);
                    set({ options: configOptions, operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        operation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The selection could not be applied.",
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
                    const settings = await client.sessions.readSessionSettingsV3(
                        sessionId,
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    const configOptions = sessionSettingsOptions(settings);
                    saveLastAgentSettings(botId, session.agentRef, configOptions);
                    set({ operation: { kind: "idle" }, options: configOptions });
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        operation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The settings could not be reloaded.",
                        },
                    });
                }
            },
            respondToPermission: async (response, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    throw new Error("The Session is not connected.");
                }
                try {
                    const interaction = get().interactions.find(
                        (candidate) =>
                            candidate.kind === "permission" &&
                            candidate.permission.interactionId === response.interactionId,
                    );
                    const optionId =
                        response.optionId.length > 0
                            ? response.optionId
                            : interaction?.kind === "permission"
                              ? (interaction.permission.options.find((option) => option.kind.startsWith("reject"))
                                    ?.optionId ?? "")
                              : "";
                    if (optionId.length === 0) {
                        throw new Error("The permission request does not provide a rejection option.");
                    }
                    await client.interactions.respondPermissionV3(
                        sessionId,
                        response.interactionId,
                        optionId,
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
                    await client.interactions.respondUserInputV3(
                        sessionId,
                        response.interactionId,
                        response.action === "accept" ? userInputValues(response.content) : {},
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
