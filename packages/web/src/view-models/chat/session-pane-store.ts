import { decodeIdentifier } from "@moxt-ai/mobius-protocol";
import {
    decodeSessionCommandsUpdatedEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    type MobiusClient,
    MobiusControlEvent,
    MobiusElicitationResponseRequest,
    type MobiusLiveSessionEventObserver,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    MobiusRunningAttemptSummary,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import {
    agentActivityKey,
    type RecordedAgentActivity,
    recordAgentActivity,
} from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
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
    applyRecordedContents,
    historySessionPresentation,
    placeAgentActivity,
    promptImageContents,
    type SessionMessage,
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
export type LocalInteraction =
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
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
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
        model.activity.kind === "working"
            ? model.activity.messageId
            : submittingCommandId !== null
              ? (model.messages.findLast(
                    (message) => message.role === "assistant" && message.commandId === submittingCommandId,
                )?.id ?? null)
              : null;
    const deliveryUnknownCommandId =
        delivery.state.kind === "delivery-unknown" ? delivery.state.journal.commandId : null;
    const deliveryUnknownUserMessageId =
        deliveryUnknownCommandId === null
            ? null
            : (model.messages.findLast((message) => message.role === "user" && message.id === deliveryUnknownCommandId)
                  ?.id ?? null);
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

function includePendingUserMessage(
    messages: readonly SessionMessage[],
    commandId: string,
    displayPrompt: string,
    images: readonly PromptImage[],
): readonly SessionMessage[] {
    if (messages.some((message) => message.role === "user" && message.id === commandId)) {
        return messages;
    }
    return [...messages, { contents: promptImageContents(images), id: commandId, role: "user", text: displayPrompt }];
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
    const activeTurn = createSessionActiveTurn({ initial: initialActiveTurn, sessionId });
    const openedActiveTurn = activeTurn.current();
    let client: MobiusClient | null = null;
    let nativeHistory: NativeSessionHistory | null =
        session.result.history.status === "available" ? session.result.history : null;
    let historyCursor = nativeHistory === null ? null : "";
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
                          name: "Bot instructions",
                          text: session.instructions ?? "",
                          type: "embedded" as const,
                          uri: instructionUri,
                      },
                  ]),
        ],
    });
    const delivery = createSessionDeliveryStore({
        sessionId,
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
    const initialDelivery = delivery.getState().state;
    const saved = historySessionPresentation(session.result.history, sessionId, command === "" ? null : command);
    const savedMessages = saved.messages;
    const persistedMessages =
        initialDelivery.kind === "delivery-unknown"
            ? includePendingUserMessage(
                  savedMessages,
                  initialDelivery.journal.commandId,
                  initialDelivery.journal.displayPrompt,
                  initialDelivery.journal.request.images,
              )
            : savedMessages;
    const initialWork =
        command === ""
            ? { activity: { kind: "idle" } as const, messages: persistedMessages }
            : startSessionWork(
                  { activity: { kind: "idle" }, messages: persistedMessages },
                  { commandId: command, attempt: null },
              );
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
    });
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };

    const store = createStore<SessionPaneStore>()((set, get) => {
        return {
            connection: { kind: "loading" },
            messages: initialWork.messages,
            historyLoading: false,
            hasOlderHistory: historyCursor !== null,
            options: session.result.ready.configOptions,
            draft: options.initialMessage?.content ?? "",
            attachments: options.initialMessage?.attachments ?? [],
            activities: saved.activities,
            interactions: [],
            operation: { kind: "idle" },
            activity: initialWork.activity,
            loadOlderMessages: async (signal) => {
                if (loadingOlderHistory || historyCursor === null || client === null) {
                    return;
                }
                loadingOlderHistory = true;
                set({ historyLoading: true });
                try {
                    const page = await client.sessions.querySessionNativeMessages(
                        sessionId,
                        {
                            additionalDirectoryIds: session.entry.additionalDirectories.map(
                                (directory) => directory.directoryId,
                            ),
                            agentId: session.agentRef,
                            directoryId: session.result.ready.directoryId,
                        },
                        new MobiusPageRequest(50, historyCursor),
                        signal,
                    );
                    signal.throwIfAborted();
                    if (page.status !== "available" || nativeHistory?.status !== "available") {
                        nativeHistory = page.status === "available" ? page : nativeHistory;
                        historyCursor = page.nextCursor;
                        set({ hasOlderHistory: historyCursor !== null });
                        return;
                    }
                    const coveredCommandIds = [...page.coveredCommandIds, ...nativeHistory.coveredCommandIds].filter(
                        (id, index, ids) => ids.indexOf(id) === index,
                    );
                    nativeHistory = {
                        ...nativeHistory,
                        messages: [...page.messages, ...nativeHistory.messages],
                        coveredCommandIds,
                        coveredMessageIds: [...page.coveredMessageIds, ...nativeHistory.coveredMessageIds].filter(
                            (id, index, ids) => ids.indexOf(id) === index,
                        ),
                        truncated: page.truncated || nativeHistory.truncated,
                    };
                    historyCursor = page.nextCursor;
                    const rendered = historySessionPresentation(nativeHistory, sessionId, command || null);
                    signal.throwIfAborted();
                    set({
                        activities: rendered.activities,
                        hasOlderHistory: historyCursor !== null,
                        messages: rendered.messages,
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
                let lastSequence = 0n;
                try {
                    client = await requests.connectSession(
                        botId,
                        sessionId,
                        signal,
                        session.result.action === "conversation" ? session.result.access : undefined,
                    );
                    const connected = client;
                    signal.addEventListener("abort", () => connected.close(), { once: true });
                    const observer: MobiusLiveSessionEventObserver = {
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
                            const identity = {
                                additionalDirectoryIds: session.entry.additionalDirectories.map(
                                    (directory) => directory.directoryId,
                                ),
                                agentId: session.agentRef,
                                directoryId: session.result.ready.directoryId,
                            };
                            const loadedHistory = await connected.sessions.querySessionNativeMessages(
                                sessionId,
                                identity,
                                new MobiusPageRequest(50, ""),
                                signal,
                            );
                            signal.throwIfAborted();
                            const provisional = historySessionPresentation(loadedHistory, sessionId);
                            nativeHistory = loadedHistory.status === "available" ? loadedHistory : null;
                            historyCursor = loadedHistory.status === "available" ? loadedHistory.nextCursor : null;
                            set({
                                activities: provisional.activities,
                                hasOlderHistory: historyCursor !== null,
                                messages: provisional.messages,
                            });
                            const running = await connected.sessions.readActiveTurn(sessionId, identity, signal);
                            signal.throwIfAborted();
                            const authoritative = {
                                history: loadedHistory,
                                kind: "authoritative-state-loaded" as const,
                            };
                            if (running !== null) {
                                command = running.commandId;
                                lastSequence = BigInt(running.sequence);
                                const turnId =
                                    reconciliation.turn.kind === "accepted" &&
                                    reconciliation.turn.commandId === running.commandId
                                        ? reconciliation.turn.turnId
                                        : running.commandId;
                                tasks.getState().start(running.commandId, turnId);
                                activeTurn.submissionAccepted(running.commandId, turnId);
                            } else if (
                                reconciliation.turn.kind === "accepted" &&
                                authoritative.history.status === "available" &&
                                authoritative.history.coveredCommandIds.includes(reconciliation.turn.commandId)
                            ) {
                                tasks.getState().finish(command);
                                activeTurn.turnCleared(command);
                                command = "";
                            }
                            const native = historySessionPresentation(
                                authoritative.history,
                                sessionId,
                                running?.commandId ?? null,
                            );
                            const nativeMessages =
                                running === null
                                    ? native.messages
                                    : native.messages.filter((message) =>
                                          message.role === "user"
                                              ? message.id !== running.commandId
                                              : message.commandId !== running.commandId,
                                      );
                            delivery
                                .getState()
                                .reconcile([
                                    ...(authoritative.history.status === "available"
                                        ? authoritative.history.coveredCommandIds
                                        : []),
                                    ...(command !== "" &&
                                    nativeMessages.some((message) => message.role === "user" && message.id === command)
                                        ? [command]
                                        : []),
                                ]);
                            const snapshotMessages: readonly SessionMessage[] =
                                running === null
                                    ? []
                                    : [
                                          {
                                              contents: [],
                                              id: running.commandId,
                                              role: "user",
                                              text: running.prompt,
                                          },
                                          {
                                              activityIds: [],
                                              attempt: null,
                                              commandId: running.commandId,
                                              contents: [],
                                              id: `${running.commandId}-reply`,
                                              role: "assistant",
                                              text: running.text,
                                          },
                                      ];
                            const liveCommandMessages =
                                running !== null
                                    ? snapshotMessages
                                    : command === "" ||
                                        (authoritative.history.status === "available" &&
                                            authoritative.history.coveredCommandIds.includes(command))
                                      ? []
                                      : get().messages.filter((message) =>
                                            message.role === "user"
                                                ? message.id === command &&
                                                  !nativeMessages.some(
                                                      (nativeMessage) =>
                                                          nativeMessage.role === "user" && nativeMessage.id === command,
                                                  )
                                                : message.commandId === command &&
                                                  !nativeMessages.some(
                                                      (nativeMessage) =>
                                                          nativeMessage.role === "assistant" &&
                                                          nativeMessage.commandId === command,
                                                  ),
                                        );
                            const restoredFromDaemon = [...nativeMessages, ...liveCommandMessages];
                            const reconciledDelivery = delivery.getState().state;
                            const restoredMessages =
                                reconciledDelivery.kind === "delivery-unknown"
                                    ? includePendingUserMessage(
                                          restoredFromDaemon,
                                          reconciledDelivery.journal.commandId,
                                          reconciledDelivery.journal.displayPrompt,
                                          reconciledDelivery.journal.request.images,
                                      )
                                    : restoredFromDaemon;
                            signal.throwIfAborted();
                            const restoredWork =
                                command === ""
                                    ? { activity: { kind: "idle" } as const, messages: restoredMessages }
                                    : startSessionWork(
                                          { activity: { kind: "idle" }, messages: restoredMessages },
                                          { commandId: command, attempt: null },
                                      );
                            const interactions: readonly LocalInteraction[] = (() => {
                                const interaction = running?.interaction;
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
                                activities: native.activities,
                                hasOlderHistory: historyCursor !== null,
                                interactions,
                                ...restoredWork,
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
                            const payload = event.payload;
                            if (payload instanceof MobiusAgentActivityEvent) {
                                if (command !== "" && payload.commandId !== command) {
                                    return true;
                                }
                                set((current) => ({
                                    activities: recordAgentActivity(current.activities, event),
                                    messages: placeAgentActivity(
                                        current.messages,
                                        payload.commandId,
                                        agentActivityKey(payload),
                                    ),
                                }));
                                return true;
                            }
                            if (payload instanceof MobiusControlEvent) {
                                if (payload.kind === "agent.content") {
                                    set((current) => ({
                                        messages: applyRecordedContents(current.messages, [event]),
                                    }));
                                } else if (payload.kind === "session.commands.updated") {
                                    tasks
                                        .getState()
                                        .updateCommands(
                                            decodeSessionCommandsUpdatedEvent(payload.encodedPayload).commands,
                                        );
                                } else if (payload.kind === "session.permission.requested") {
                                    const permission = decodeSessionPermissionRequestedEvent(payload.encodedPayload);
                                    set((current) => ({
                                        interactions: replaceInteraction(
                                            current.interactions,
                                            permission.interactionId,
                                            {
                                                kind: "permission",
                                                permission: { ...permission, state: { kind: "pending" } },
                                            },
                                        ),
                                    }));
                                } else if (payload.kind === "session.permission.resolved") {
                                    const resolved = decodeSessionPermissionResolvedEvent(payload.encodedPayload);
                                    set((current) => ({
                                        interactions: resolvePermission(
                                            current.interactions,
                                            resolved.interactionId,
                                            resolved.outcome,
                                            resolved.optionId,
                                        ),
                                    }));
                                } else if (payload.kind === "session.elicitation.requested") {
                                    const { accepted, ...elicitation } = decodeSessionElicitationRequestedEvent(
                                        payload.encodedPayload,
                                    );
                                    set((current) => ({
                                        interactions: replaceInteraction(
                                            current.interactions,
                                            elicitation.interactionId,
                                            {
                                                kind: "elicitation",
                                                elicitation: {
                                                    ...elicitation,
                                                    state: accepted
                                                        ? {
                                                              action: "accept",
                                                              content: "",
                                                              kind: "submitted",
                                                          }
                                                        : { kind: "pending" },
                                                },
                                            },
                                        ),
                                    }));
                                } else if (payload.kind === "session.elicitation.resolved") {
                                    const resolved = decodeSessionElicitationResolvedEvent(payload.encodedPayload);
                                    set((current) => ({
                                        interactions: resolveElicitation(
                                            current.interactions,
                                            resolved.interactionId,
                                            resolved.action,
                                        ),
                                    }));
                                }
                            }
                            if (
                                payload instanceof MobiusTurnStartedEvent &&
                                messageQueue
                                    .getState()
                                    .messages.some((message) => message.commandId === payload.commandId)
                            ) {
                                const queued = messageQueue.getState().takeStarted(payload.commandId);
                                if (queued !== null) {
                                    if (command !== "") {
                                        tasks.getState().finish(command);
                                    }
                                    command = queued.commandId;
                                    tasks.getState().start(queued.commandId, queued.turnId);
                                    activeTurn.submissionAccepted(queued.commandId, queued.turnId);
                                    set((current) =>
                                        startSessionWork(
                                            {
                                                activity: current.activity,
                                                messages: [
                                                    ...current.messages,
                                                    {
                                                        id: `${queued.commandId}-user`,
                                                        role: "user",
                                                        text: queued.summary,
                                                        contents: promptImageContents(queued.images),
                                                    },
                                                ],
                                            },
                                            {
                                                commandId: queued.commandId,
                                                attempt: new MobiusRunningAttemptSummary(
                                                    payload.attemptId,
                                                    event.recordedAt,
                                                ),
                                            },
                                        ),
                                    );
                                    return true;
                                }
                            }
                            if (command === "" && payload instanceof MobiusTurnStartedEvent) {
                                command = payload.commandId;
                                tasks.getState().start(payload.commandId, payload.commandId);
                                activeTurn.submissionAccepted(payload.commandId, payload.commandId);
                                if (event.sequence !== "") {
                                    lastSequence = BigInt(event.sequence);
                                }
                                set((current) =>
                                    startSessionWork(
                                        {
                                            activity: current.activity,
                                            messages: [
                                                ...current.messages,
                                                {
                                                    contents: [],
                                                    id: payload.commandId,
                                                    role: "user",
                                                    text: payload.prompt,
                                                },
                                            ],
                                        },
                                        {
                                            commandId: payload.commandId,
                                            attempt: new MobiusRunningAttemptSummary(
                                                payload.attemptId,
                                                event.recordedAt,
                                            ),
                                        },
                                    ),
                                );
                                return true;
                            }
                            if (
                                command === "" ||
                                !("commandId" in payload) ||
                                payload.commandId !== command ||
                                (event.sequence !== "" && BigInt(event.sequence) <= lastSequence)
                            ) {
                                return true;
                            }
                            if (event.sequence !== "") {
                                lastSequence = BigInt(event.sequence);
                            }
                            if (payload instanceof MobiusAgentMessageEvent) {
                                set((current) => {
                                    const target = current.messages.findLastIndex(
                                        (item) => item.role === "assistant" && item.commandId === command,
                                    );
                                    return {
                                        messages: current.messages.map((item, index) =>
                                            index === target && item.role === "assistant"
                                                ? { ...item, text: item.text + payload.text }
                                                : item,
                                        ),
                                    };
                                });
                            } else if (payload instanceof MobiusTurnStartedEvent) {
                                set((current) =>
                                    startSessionWork(current, {
                                        commandId: command,
                                        attempt: new MobiusRunningAttemptSummary(payload.attemptId, event.recordedAt),
                                    }),
                                );
                            } else if (
                                payload instanceof MobiusTurnCompletedEvent ||
                                payload instanceof MobiusTurnFailedEvent
                            ) {
                                const completedCommand = command;
                                const completedHistory =
                                    payload instanceof MobiusTurnCompletedEvent
                                        ? await connected.sessions.querySessionNativeMessages(
                                              sessionId,
                                              {
                                                  additionalDirectoryIds: session.entry.additionalDirectories.map(
                                                      (directory) => directory.directoryId,
                                                  ),
                                                  agentId: session.agentRef,
                                                  directoryId: session.result.ready.directoryId,
                                              },
                                              new MobiusPageRequest(50, ""),
                                              AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                                          )
                                        : null;
                                signal.throwIfAborted();
                                if (command !== completedCommand) {
                                    return true;
                                }
                                const completed =
                                    completedHistory?.status === "available"
                                        ? historySessionPresentation(completedHistory, sessionId)
                                        : null;
                                if (completedHistory?.status === "available") {
                                    delivery.getState().reconcile(completedHistory.coveredCommandIds);
                                }
                                set((current) => ({
                                    activity:
                                        payload instanceof MobiusTurnFailedEvent
                                            ? transitionSessionActivity(current.activity, {
                                                  commandId: completedCommand,
                                                  kind: "work-failed",
                                                  message: payload.message,
                                              })
                                            : transitionSessionActivity(current.activity, {
                                                  commandId: completedCommand,
                                                  kind: "work-completed",
                                              }),
                                    activities: completed?.activities ?? current.activities,
                                    messages: completed?.messages ?? current.messages,
                                    operation: { kind: "idle" },
                                }));
                                tasks.getState().finish(completedCommand);
                                activeTurn.turnCleared(completedCommand);
                                command = "";
                            }
                            return true;
                        },
                    };
                    const subscription = await connected.events.subscribeLive(sessionId, observer, signal);
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
                set((state) => ({
                    draft: "",
                    attachments: [],
                    operation: { kind: "sending", commandId },
                    messages: [
                        ...state.messages,
                        { id: commandId, role: "user", text: displayPrompt, contents: promptImageContents(images) },
                        {
                            activityIds: [],
                            id: `${commandId}-reply`,
                            role: "assistant",
                            text: "",
                            attempt: null,
                            commandId,
                            contents: [],
                        },
                    ],
                }));
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
                        set((current) => ({
                            ...startSessionWork(current, { commandId, attempt: null }),
                            operation: { kind: "idle" },
                        }));
                    } else {
                        activeTurn.turnCleared(commandId);
                        command = "";
                        set({ operation: { kind: "idle" } });
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
                set((current) => ({
                    activity: transitionSessionActivity(current.activity, { commandId, kind: "work-completed" }),
                    messages: current.messages.filter((message) =>
                        message.role === "user" ? message.id !== commandId : message.commandId !== commandId,
                    ),
                }));
            },
            retryUnknownDelivery: async (signal) => {
                const state = delivery.getState().state;
                if (get().connection.kind !== "ready" || state.kind !== "delivery-unknown") {
                    return;
                }
                const pending = state.journal;
                command = pending.commandId;
                set((current) => {
                    let messages: readonly SessionMessage[] = current.messages;
                    if (!messages.some((message) => message.role === "user" && message.id === pending.commandId)) {
                        messages = [
                            ...messages,
                            {
                                id: pending.commandId,
                                role: "user",
                                text: pending.displayPrompt,
                                contents: promptImageContents(pending.request.images),
                            },
                        ];
                    }
                    return startSessionWork(
                        { activity: current.activity, messages },
                        { commandId: pending.commandId, attempt: null },
                    );
                });
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
                    set({ draft: "", attachments: [] });
                }
            },
            steerQueued: async (commandId, signal) => {
                const steered = await messageQueue.getState().steerMessage(commandId, signal);
                signal.throwIfAborted();
                if (steered !== null) {
                    set((current) => ({
                        messages: [
                            ...current.messages,
                            {
                                id: `${steered.commandId}-user`,
                                role: "user",
                                text: steered.summary,
                                contents: promptImageContents(steered.images),
                            },
                        ],
                    }));
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
                    (commandId, prompt) => {
                        command = commandId;
                        set((state) =>
                            startSessionWork(
                                {
                                    activity: state.activity,
                                    messages: [
                                        ...state.messages,
                                        { id: `${commandId}-user`, role: "user", text: prompt, contents: [] },
                                    ],
                                },
                                { commandId, attempt: null },
                            ),
                        );
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
