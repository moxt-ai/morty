import { decodeIdentifier } from "@moxt-ai/mobius-protocol";
import {
    decodeAgentContentEvent,
    decodeSessionCommandsUpdatedEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    MobiusAgentActivityEvent,
    MobiusAgentActivityNarrationEvent,
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
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
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
    activeTurnSessionPresentation,
    appendLiveTurnNarration,
    appendLiveTurnText,
    appendSessionTimelineSegment,
    deriveSessionTimeline,
    historySessionPresentation,
    recordLiveTurnActivity,
    recordLiveTurnContent,
    type SessionMessage,
    type SessionTimelineSegment,
    startLiveTurnSessionPresentation,
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
        workingActivityCommandId !== null
            ? (model.messages.findLast(
                  (message) => message.role === "assistant" && message.commandId === workingActivityCommandId,
              )?.id ?? null)
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

interface SessionIdentity {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
}

type SessionExecution = Awaited<ReturnType<MobiusClient["sessions"]["readSessionExecution"]>>;

function executionEpoch(execution: SessionExecution): string {
    return execution.turn === null ? "idle" : `${execution.turn.commandId}:${execution.turn.epoch}`;
}

function historyCommandIds(history: NativeSessionHistory): readonly string[] {
    if (history.status !== "available") {
        return [];
    }
    const ids = [...history.coveredCommandIds];
    for (const messageId of history.coveredMessageIds) {
        const suffix = messageId.endsWith(":user") ? ":user" : messageId.endsWith(":agent") ? ":agent" : null;
        if (suffix === null) {
            continue;
        }
        const commandId = messageId.slice(0, -suffix.length);
        if (!ids.includes(commandId)) {
            ids.push(commandId);
        }
    }
    return ids;
}

async function readCompleteNativeHistory(
    client: MobiusClient,
    sessionId: string,
    identity: SessionIdentity,
    signal: AbortSignal,
): Promise<NativeSessionHistory> {
    const messages: Extract<NativeSessionHistory, { readonly status: "available" }>["messages"][number][] = [];
    const coveredCommandIds: string[] = [];
    const coveredMessageIds: string[] = [];
    const visitedCursors = new Set<string>();
    let cursor = "";
    let truncated = false;
    for (;;) {
        const page = await client.sessions.querySessionNativeMessages(
            sessionId,
            identity,
            new MobiusPageRequest(50, cursor),
            signal,
        );
        signal.throwIfAborted();
        if (page.status === "unavailable") {
            return { cause: page.cause, status: "unavailable" };
        }
        messages.unshift(...page.messages);
        coveredCommandIds.push(...page.coveredCommandIds);
        coveredMessageIds.push(...page.coveredMessageIds);
        truncated ||= page.truncated;
        if (page.nextCursor === null) {
            return {
                coveredCommandIds: coveredCommandIds.filter((id, index, ids) => ids.indexOf(id) === index),
                coveredMessageIds: coveredMessageIds.filter((id, index, ids) => ids.indexOf(id) === index),
                messages,
                status: "available",
                truncated,
            };
        }
        if (visitedCursors.has(page.nextCursor)) {
            throw new Error("The Runtime returned a repeating Session history cursor.");
        }
        visitedCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}

async function readConsistentSessionRecovery(
    client: MobiusClient,
    sessionId: string,
    identity: SessionIdentity,
    signal: AbortSignal,
): Promise<{ readonly execution: SessionExecution; readonly history: NativeSessionHistory }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await client.sessions.readSessionExecution(sessionId, identity, signal);
        const history = await readCompleteNativeHistory(client, sessionId, identity, signal);
        const after = await client.sessions.readSessionExecution(sessionId, identity, signal);
        signal.throwIfAborted();
        if (executionEpoch(before) === executionEpoch(after)) {
            return { execution: after, history };
        }
    }
    throw new Error("The Session changed while its running Turn and history were being recovered.");
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
        command === "" ? { kind: "idle" } : startSessionWork({ commandId: command, attempt: null });
    let liveTurn: SessionTimelineSegment | null = null;
    const deriveTimeline = (activity: SessionActivityState) => {
        const history = historySessionPresentation(nativeHistory ?? session.result.history, sessionId);
        return deriveSessionTimeline(
            history,
            liveTurn,
            activity.kind === "working" ? { attempt: activity.attempt, commandId: activity.commandId } : null,
        );
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
    const draftEntry = sessionDraftEntry(sessionId);
    const initialTimeline = deriveTimeline(initialActivity);

    const store = createStore<SessionPaneStore>()((set, get) => {
        return {
            connection: { kind: "loading" },
            messages: initialTimeline.messages,
            historyLoading: false,
            hasOlderHistory: historyCursor !== null,
            options: session.result.ready.configOptions,
            draft: options.initialMessage?.content ?? centralLocalStorage.read(draftEntry) ?? "",
            attachments: options.initialMessage?.attachments ?? [],
            activities: initialTimeline.activities,
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
                    const timeline = deriveTimeline(get().activity);
                    signal.throwIfAborted();
                    set({
                        activities: timeline.activities,
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
                            const { execution, history: loadedHistory } = await readConsistentSessionRecovery(
                                connected,
                                sessionId,
                                identity,
                                signal,
                            );
                            const running = execution.turn;
                            messageQueue.getState().replace(execution.queued);
                            nativeHistory = loadedHistory.status === "available" ? loadedHistory : null;
                            historyCursor = null;
                            liveTurn =
                                loadedHistory.status === "unavailable" && running !== null
                                    ? activeTurnSessionPresentation(running, sessionId)
                                    : null;
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
                                command === ""
                                    ? ({ kind: "idle" } as const)
                                    : startSessionWork({ commandId: command, attempt: null });
                            const native = deriveTimeline(restoredActivity);
                            const nativeMessages = native.messages;
                            delivery.getState().reconcile(historyCommandIds(loadedHistory));
                            signal.throwIfAborted();
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
                            const payload = event.payload;
                            if (payload instanceof MobiusControlEvent && payload.kind === "session.queue.changed") {
                                const execution = await connected.sessions.readSessionExecution(
                                    sessionId,
                                    {
                                        additionalDirectoryIds: session.entry.additionalDirectories.map(
                                            (directory) => directory.directoryId,
                                        ),
                                        agentId: session.agentRef,
                                        directoryId: session.result.ready.directoryId,
                                    },
                                    signal,
                                );
                                signal.throwIfAborted();
                                messageQueue.getState().replace(execution.queued);
                                const running = execution.turn;
                                if (running === null) {
                                    return true;
                                }
                                if (command === running.commandId) {
                                    return true;
                                }
                                const priorCommand = command;
                                const recovery = await readConsistentSessionRecovery(
                                    connected,
                                    sessionId,
                                    {
                                        additionalDirectoryIds: session.entry.additionalDirectories.map(
                                            (directory) => directory.directoryId,
                                        ),
                                        agentId: session.agentRef,
                                        directoryId: session.result.ready.directoryId,
                                    },
                                    signal,
                                );
                                const recoveredRunning = recovery.execution.turn;
                                if (recoveredRunning === null) {
                                    return true;
                                }
                                if (priorCommand !== "" && priorCommand !== recoveredRunning.commandId) {
                                    tasks.getState().finish(priorCommand);
                                    activeTurn.turnCleared(priorCommand);
                                }
                                command = recoveredRunning.commandId;
                                const accepted = activeTurn.current();
                                const turnId =
                                    accepted.kind === "accepted" && accepted.commandId === recoveredRunning.commandId
                                        ? accepted.turnId
                                        : recoveredRunning.commandId;
                                tasks.getState().start(recoveredRunning.commandId, turnId);
                                activeTurn.submissionAccepted(recoveredRunning.commandId, turnId);
                                nativeHistory = recovery.history.status === "available" ? recovery.history : null;
                                historyCursor = null;
                                liveTurn =
                                    recovery.history.status === "unavailable"
                                        ? activeTurnSessionPresentation(recoveredRunning, sessionId)
                                        : null;
                                delivery.getState().reconcile(historyCommandIds(recovery.history));
                                const activity = startSessionWork({
                                    commandId: recoveredRunning.commandId,
                                    attempt: null,
                                });
                                const snapshot = deriveTimeline(activity);
                                set({
                                    activities: snapshot.activities,
                                    activity,
                                    hasOlderHistory: historyCursor !== null,
                                    messages: snapshot.messages,
                                });
                                return true;
                            }

                            if (payload instanceof MobiusControlEvent) {
                                if (payload.kind === "agent.content") {
                                    const content = decodeAgentContentEvent(payload.encodedPayload);
                                    if (command === content.commandId) {
                                        liveTurn = recordLiveTurnContent(liveTurn, content);
                                        const timeline = deriveTimeline(get().activity);
                                        set({ activities: timeline.activities, messages: timeline.messages });
                                    }
                                    return true;
                                }
                                if (payload.kind === "session.commands.updated") {
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
                                    if (command !== "" && command !== queued.commandId) {
                                        const timeline = deriveTimeline(get().activity);
                                        set({ activities: timeline.activities, messages: timeline.messages });
                                        return true;
                                    }
                                    command = queued.commandId;
                                    liveTurn = appendSessionTimelineSegment(
                                        liveTurn,
                                        startLiveTurnSessionPresentation(queued.commandId, payload.prompt),
                                    );
                                    tasks.getState().start(queued.commandId, queued.turnId);
                                    activeTurn.submissionAccepted(queued.commandId, queued.turnId);
                                    const activity = startSessionWork({
                                        commandId: queued.commandId,
                                        attempt: new MobiusRunningAttemptSummary(payload.attemptId, event.recordedAt),
                                    });
                                    const timeline = deriveTimeline(activity);
                                    set({ activities: timeline.activities, activity, messages: timeline.messages });
                                    return true;
                                }
                            }
                            if (command === "" && payload instanceof MobiusTurnStartedEvent) {
                                command = payload.commandId;
                                liveTurn = appendSessionTimelineSegment(
                                    liveTurn,
                                    startLiveTurnSessionPresentation(payload.commandId, payload.prompt),
                                );
                                tasks.getState().start(payload.commandId, payload.commandId);
                                activeTurn.submissionAccepted(payload.commandId, payload.commandId);
                                const activity = startSessionWork({
                                    commandId: payload.commandId,
                                    attempt: new MobiusRunningAttemptSummary(payload.attemptId, event.recordedAt),
                                });
                                const timeline = deriveTimeline(activity);
                                set({ activities: timeline.activities, activity, messages: timeline.messages });
                                return true;
                            }
                            if (command === "" || !("commandId" in payload) || payload.commandId !== command) {
                                return true;
                            }
                            if (payload instanceof MobiusAgentMessageEvent) {
                                liveTurn = appendLiveTurnText(liveTurn, payload.commandId, payload.text);
                                const timeline = deriveTimeline(get().activity);
                                set({ activities: timeline.activities, messages: timeline.messages });
                            } else if (payload instanceof MobiusAgentActivityEvent) {
                                liveTurn = recordLiveTurnActivity(liveTurn, payload);
                                const timeline = deriveTimeline(get().activity);
                                set({ activities: timeline.activities, messages: timeline.messages });
                            } else if (payload instanceof MobiusAgentActivityNarrationEvent) {
                                liveTurn = appendLiveTurnNarration(liveTurn, payload);
                                const timeline = deriveTimeline(get().activity);
                                set({ activities: timeline.activities, messages: timeline.messages });
                            } else if (payload instanceof MobiusTurnStartedEvent) {
                                if (liveTurn === null) {
                                    liveTurn = startLiveTurnSessionPresentation(payload.commandId, payload.prompt);
                                }
                                const activity = startSessionWork({
                                    commandId: command,
                                    attempt: new MobiusRunningAttemptSummary(payload.attemptId, event.recordedAt),
                                });
                                const timeline = deriveTimeline(activity);
                                set({ activities: timeline.activities, activity, messages: timeline.messages });
                            } else if (
                                payload instanceof MobiusTurnCompletedEvent ||
                                payload instanceof MobiusTurnFailedEvent
                            ) {
                                const completedCommand = command;
                                // The native history may already contain the next queued prompt.
                                // Finish this streamed turn without replacing it with a later snapshot.
                                delivery.getState().reconcile([completedCommand]);
                                const activity =
                                    payload instanceof MobiusTurnFailedEvent
                                        ? transitionSessionActivity(get().activity, {
                                              commandId: completedCommand,
                                              kind: "work-failed",
                                              message: payload.message,
                                          })
                                        : transitionSessionActivity(get().activity, {
                                              commandId: completedCommand,
                                              kind: "work-completed",
                                          });
                                const completed = deriveTimeline(activity);
                                set({
                                    activities: completed.activities,
                                    activity,
                                    messages: completed.messages,
                                    operation: { kind: "idle" },
                                });
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
                const activity = startSessionWork({ commandId, attempt: null });
                const pending = deriveTimeline(activity);
                set({
                    activities: pending.activities,
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
                        const restored = deriveTimeline(idle);
                        set({
                            activities: restored.activities,
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
                const restored = deriveTimeline(activity);
                set({ activities: restored.activities, activity, messages: restored.messages });
            },
            retryUnknownDelivery: async (signal) => {
                const state = delivery.getState().state;
                if (get().connection.kind !== "ready" || state.kind !== "delivery-unknown") {
                    return;
                }
                const pending = state.journal;
                command = pending.commandId;
                const retrying = startSessionWork({ commandId: pending.commandId, attempt: null });
                const retried = deriveTimeline(retrying);
                set({ activities: retried.activities, activity: retrying, messages: retried.messages });
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
                    const timeline = deriveTimeline(get().activity);
                    set({ activities: timeline.activities, messages: timeline.messages });
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
                        const activity = startSessionWork({ commandId, attempt: null });
                        const timeline = deriveTimeline(activity);
                        set({ activities: timeline.activities, activity, messages: timeline.messages });
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
