import { type AcpSessionUpdateV2, decodeIdentifier, type SessionEventV2 } from "@moxt-ai/mobius-protocol";
import {
    type MobiusClient,
    MobiusElicitationResponseRequest,
    type MobiusLiveSessionEventObserverV2,
    MobiusPermissionResponseRequest,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
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
import {
    createSessionTimelineProjection,
    type SessionMessage,
    sessionEventCommandIds,
} from "./session-presentation.ts";
import {
    createSessionTaskControlsStore,
    findCompactCommand,
    type SessionTaskControlsStore,
} from "./session-task-controls.ts";

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
    readonly messages: readonly SessionMessage[];
    readonly historyLoading: boolean;
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
    readonly compact: (signal: AbortSignal) => Promise<void>;
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
        tasks.operation.kind === "compacting" ||
        waitingForInput ||
        queue.operation.kind === "submitting" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const workingActivityCommandId = workingCommandId(model.activity);
    const submittingCommandId = model.operation.kind === "sending" ? model.operation.commandId : null;
    const activeCommandId = workingActivityCommandId ?? submittingCommandId;
    const busy = activeCommandId !== null || composerDisabled;
    const compactAvailable = findCompactCommand(tasks.commands) !== null;
    const activeMessageId =
        workingActivityCommandId !== null || submittingCommandId !== null
            ? (model.messages.findLast((message) => message.role === "assistant")?.id ?? null)
            : null;
    const deliveryUnknownCommandId =
        delivery.state.kind === "delivery-unknown" ? delivery.state.journal.commandId : null;
    const deliveryUnknownUserMessageId = deliveryUnknownCommandId === null ? null : deliveryUnknownCommandId;
    return {
        activeMessageId,
        activeCommandId,
        busy,
        composerDisabled,
        compactAvailable,
        compactDisabled:
            model.connection.kind !== "ready" ||
            model.operation.kind !== "idle" ||
            tasks.operation.kind !== "idle" ||
            !compactAvailable,
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

function sessionConfigOptionsFromAcp(
    update: Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "config_option_update" }>,
): readonly SessionConfigOption[] {
    return update.configOptions.map((option) => ({
        booleanValue: option.type === "boolean" ? option.currentValue : false,
        category: option.category ?? "",
        currentValue: option.type === "select" ? option.currentValue : "",
        description: option.description ?? "",
        id: option.id,
        name: option.name,
        type: option.type,
        values:
            option.type === "boolean"
                ? []
                : option.options.flatMap((item) =>
                      "group" in item
                          ? item.options.map((value) => ({
                                description: value.description ?? "",
                                groupId: item.group,
                                groupName: item.name,
                                name: value.name,
                                value: value.value,
                            }))
                          : [
                                {
                                    description: item.description ?? "",
                                    groupId: "",
                                    groupName: "",
                                    name: item.name,
                                    value: item.value,
                                },
                            ],
                  ),
    }));
}

interface SessionEventRecoveryV2 {
    readonly daemonGenerationId: string;
    readonly events: readonly SessionEventV2[];
    readonly nextCursor: string | null;
}

async function readNativeEventsV2(
    client: MobiusClient,
    sessionId: string,
    identity: SessionIdentity,
    signal: AbortSignal,
): Promise<SessionEventRecoveryV2> {
    const page = await client.sessions.querySessionNativeEventsV2(
        sessionId,
        identity,
        { cursor: null, eventLimit: 200 },
        signal,
    );
    signal.throwIfAborted();
    return {
        daemonGenerationId: page.events.daemonGenerationId,
        events: page.events.events,
        nextCursor: page.events.nextCursor,
    };
}

function mergeSessionEvents(
    current: readonly SessionEventV2[],
    incoming: readonly SessionEventV2[],
): readonly SessionEventV2[] {
    const byId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
        byId.set(event.eventId, event);
    }
    return [...byId.values()].sort((left, right) =>
        left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0,
    );
}

export function createSessionPaneModel(options: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly initialMessage?: QueuedDraftMessage | undefined;
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
    let client: MobiusClient | null = null;
    let sessionEvents: SessionEventV2[] = [];
    let daemonGenerationId: string | null = null;
    let historyCursor: string | null = null;
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
    const initialActivity: SessionActivityState =
        command === "" ? { kind: "idle" } : startSessionWork({ commandId: command });
    let timelineProjection = createSessionTimelineProjection(sessionEvents);
    const deriveTimeline = () => timelineProjection.current();
    const replaceTimeline = (events: readonly SessionEventV2[]): void => {
        sessionEvents = [...events];
        timelineProjection = createSessionTimelineProjection(sessionEvents);
    };
    const tasks = createSessionTaskControlsStore({
        commands: session.result.ready.commands,
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
        return {
            connection: { kind: "loading" },
            messages: initialTimeline.messages,
            historyLoading: false,
            hasOlderHistory: historyCursor !== null,
            options: session.result.ready.configOptions,
            draft: options.initialMessage?.content ?? centralLocalStorage.read(draftEntry) ?? "",
            attachments: options.initialMessage?.attachments ?? [],
            interactions: [],
            operation: { kind: "idle" },
            activity: initialActivity,
            loadOlderMessages: async (signal) => {
                if (loadingOlderHistory || historyCursor === null || client === null) {
                    return;
                }
                loadingOlderHistory = true;
                set({ historyLoading: true });
                try {
                    const page = await client.sessions.querySessionNativeEventsV2(
                        sessionId,
                        {
                            additionalDirectoryIds: session.entry.additionalDirectories.map(
                                (directory) => directory.directoryId,
                            ),
                            agentId: session.agentRef,
                            directoryId: session.result.ready.directoryId,
                        },
                        { cursor: historyCursor, eventLimit: 200 },
                        signal,
                    );
                    signal.throwIfAborted();
                    if (daemonGenerationId !== null && page.events.daemonGenerationId !== daemonGenerationId) {
                        throw new Error("The Runtime restarted while older messages were loading.");
                    }
                    replaceTimeline(mergeSessionEvents(page.events.events, sessionEvents));
                    historyCursor = page.events.nextCursor;
                    const timeline = deriveTimeline();
                    signal.throwIfAborted();
                    set({
                        hasOlderHistory: historyCursor !== null,
                        messages: timeline.messages,
                    });
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
                            set({ activity: startSessionWork({ commandId: payload.commandId }) });
                            return true;
                        }
                        if (
                            payload.kind === "prompt.completed" ||
                            payload.kind === "prompt.failed" ||
                            payload.kind === "prompt.failed-before-start"
                        ) {
                            delivery.getState().reconcile([payload.commandId]);
                            if (payload.kind === "prompt.completed" && payload.stopReason === "steered") {
                                const [recovery, execution] = await Promise.all([
                                    readNativeEventsV2(connected, sessionId, sessionIdentity, signal),
                                    connected.sessions.readSessionExecution(sessionId, sessionIdentity, signal),
                                ]);
                                signal.throwIfAborted();
                                replaceTimeline(mergeSessionEvents(sessionEvents, recovery.events));
                                const running = execution.turn;
                                if (running !== null) {
                                    command = running.commandId;
                                    tasks.getState().start(running.commandId, running.commandId);
                                    activeTurn.submissionAccepted(running.commandId, running.commandId);
                                    const timeline = deriveTimeline();
                                    set({
                                        activity: startSessionWork({ commandId: running.commandId }),
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
                            const [recovery, execution] = await Promise.all([
                                readNativeEventsV2(connected, sessionId, sessionIdentity, signal),
                                connected.sessions.readSessionExecution(sessionId, sessionIdentity, signal),
                            ]);
                            daemonGenerationId = recovery.daemonGenerationId;
                            const running = execution.turn;
                            messageQueue.getState().replace(execution.queued);
                            replaceTimeline(recovery.events);
                            historyCursor = recovery.nextCursor;
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
                            const restoredActivity =
                                command === "" ? ({ kind: "idle" } as const) : startSessionWork({ commandId: command });
                            const native = deriveTimeline();
                            const nativeMessages = native.messages;
                            delivery.getState().reconcile(sessionEventCommandIds(sessionEvents));
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
                                hasOlderHistory: historyCursor !== null,
                                interactions,
                                activity: restoredActivity,
                                messages: nativeMessages,
                            });
                            switch (reconciliation.kind) {
                                case "initial-subscription":
                                    break;
                                case "reconnecting":
                                    set({ connection: { client: connected, kind: "ready" } });
                                    break;
                            }
                        },
                        receive: async (event) => {
                            const latest = sessionEvents.at(-1);
                            if (latest === undefined || latest.eventId < event.eventId) {
                                sessionEvents.push(event);
                                timelineProjection.append(event);
                            } else if (!sessionEvents.some((candidate) => candidate.eventId === event.eventId)) {
                                replaceTimeline(mergeSessionEvents(sessionEvents, [event]));
                            }
                            if (event.type !== "acp") {
                                await receiveLifecycle(event.payload);
                                const timeline = deriveTimeline();
                                if (timeline.messages !== get().messages) {
                                    set({ messages: timeline.messages });
                                }
                                return true;
                            }
                            const update = event.payload;
                            if (update.sessionUpdate === "available_commands_update") {
                                tasks.getState().updateCommands(
                                    update.availableCommands.map((available) => ({
                                        description: available.description,
                                        inputHint: available.input?.hint ?? "",
                                        name: available.name,
                                    })),
                                );
                            }
                            if (update.sessionUpdate === "config_option_update") {
                                const configOptions = sessionConfigOptionsFromAcp(update);
                                sessionConfigurations = configOptions.map((candidate) => ({
                                    booleanValue: candidate.type === "boolean" ? candidate.booleanValue : false,
                                    configId: candidate.id,
                                    value: candidate.type === "select" ? candidate.currentValue : "",
                                    valueType: candidate.type,
                                }));
                                saveLastAgentSettings(botId, session.agentRef, configOptions);
                                set({ options: configOptions });
                            }
                            const timeline = deriveTimeline();
                            if (timeline.messages !== get().messages) {
                                set({ messages: timeline.messages });
                            }
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
                const activity = startSessionWork({ commandId });
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
                const retrying = startSessionWork({ commandId: pending.commandId });
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
            compact: async (signal) => {
                if (get().connection.kind !== "ready") {
                    return;
                }
                await tasks.getState().compact(
                    { ...request, images: [], resources: [] },
                    (commandId, _prompt) => {
                        command = commandId;
                        const activity = startSessionWork({ commandId });
                        const timeline = deriveTimeline();
                        set({ activity, messages: timeline.messages });
                    },
                    signal,
                );
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
                    const connected = client;
                    const recovery = await readNativeEventsV2(connected, sessionId, sessionIdentity, signal);
                    replaceTimeline(mergeSessionEvents(sessionEvents, recovery.events));
                    // The newest events page carries the Agent's latest
                    // config_option_update, so it is the authoritative view of
                    // the session's harness settings.
                    let options = get().options;
                    for (let index = sessionEvents.length - 1; index >= 0; index -= 1) {
                        const event = sessionEvents[index];
                        if (
                            event !== undefined &&
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "config_option_update"
                        ) {
                            options = sessionConfigOptionsFromAcp(event.payload);
                            break;
                        }
                    }
                    sessionConfigurations = options.map((candidate) => ({
                        booleanValue: candidate.type === "boolean" ? candidate.booleanValue : false,
                        configId: candidate.id,
                        value: candidate.type === "select" ? candidate.currentValue : "",
                        valueType: candidate.type,
                    }));
                    saveLastAgentSettings(botId, session.agentRef, options);
                    set({ messages: deriveTimeline().messages, operation: { kind: "idle" }, options });
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
