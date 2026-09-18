import {
    decodeSessionCommandsUpdatedEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    MobiusControlEvent,
    MobiusElicitationResponseRequest,
    MobiusPermissionResponseRequest,
    MobiusRunningAttemptSummary,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { type MobiusClient, MobiusPageRequest } from "@moxt-ai/mobius-sdk/browser";
import { createStore } from "zustand/vanilla";
import {
    agentActivityKey,
    type RecordedAgentActivity,
    recordAgentActivity,
} from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { createRemoteAccessStore } from "./remote-access-store.ts";
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
    historySessionMessages,
    placeAgentActivity,
    restoreSessionPresentation,
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
    | { readonly kind: "failed" };
type ServiceInteraction = Awaited<ReturnType<MobiusClient["interactions"]["listPending"]>>[number];
export type LocalInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

function acceptedUrlInteraction(interaction: ServiceInteraction): boolean {
    if (
        interaction.request.kind !== "elicitation" ||
        interaction.request.mode !== "url" ||
        interaction.state.kind !== "responded" ||
        interaction.state.response.kind !== "elicitation"
    ) {
        return false;
    }
    try {
        const response: unknown = JSON.parse(interaction.state.response.content);
        return (
            typeof response === "object" &&
            response !== null &&
            !Array.isArray(response) &&
            Reflect.get(response, "action") === "accept"
        );
    } catch {
        return false;
    }
}

function presentInteraction(interaction: ServiceInteraction): LocalInteraction | null {
    if (interaction.request.kind === "permission") {
        return interaction.state.kind === "pending"
            ? {
                  kind: "permission",
                  permission: {
                      interactionId: interaction.interactionId,
                      options: interaction.request.options,
                      sessionId: interaction.sessionId,
                      title: interaction.request.title,
                      toolCallId: interaction.request.toolCallId,
                      toolKind: interaction.request.toolKind,
                  },
              }
            : null;
    }
    if (interaction.state.kind !== "pending" && !acceptedUrlInteraction(interaction)) {
        return null;
    }
    return {
        kind: "elicitation",
        elicitation: {
            accepted: interaction.state.kind === "responded",
            fields: interaction.request.fields,
            interactionId: interaction.interactionId,
            message: interaction.request.message,
            mode: interaction.request.mode,
            sessionId: interaction.sessionId,
            url: interaction.request.url,
        },
    };
}

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

export interface SessionPaneStore {
    readonly connection: Connection;
    readonly messages: readonly SessionMessage[];
    readonly options: readonly SessionConfigOption[];
    readonly draft: string;
    readonly attachments: readonly ComposerAttachment[];
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly interactions: readonly LocalInteraction[];
    readonly operation: Operation;
    readonly activeCommandId: string | null;
    readonly connect: (signal: AbortSignal) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly setAttachments: (attachments: readonly ComposerAttachment[]) => void;
    readonly send: (signal: AbortSignal) => Promise<void>;
    readonly retryUnknownDelivery: (signal: AbortSignal) => Promise<void>;
    readonly queueDraft: (signal: AbortSignal) => Promise<void>;
    readonly steerQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly deleteQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly compact: (signal: AbortSignal) => Promise<void>;
    readonly configure: (option: SessionConfigOption, value: string, signal: AbortSignal) => Promise<void>;
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly stop: (signal: AbortSignal) => Promise<void>;
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
) {
    const controlRunning =
        tasks.operation.kind === "running" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const busy =
        model.connection.kind !== "ready" ||
        model.activeCommandId !== null ||
        delivery.state.kind === "submitting" ||
        delivery.state.kind === "delivery-unknown" ||
        model.operation.kind === "sending" ||
        model.operation.kind === "configuring" ||
        tasks.operation.kind === "compacting" ||
        queue.operation.kind === "submitting" ||
        tasks.operation.kind === "steering" ||
        tasks.operation.kind === "stopping";
    const compactAvailable = findCompactCommand(tasks.commands) !== null;
    const activeMessageId =
        model.activeCommandId === null
            ? null
            : (model.messages.findLast(
                  (message) => message.role === "assistant" && message.commandId === model.activeCommandId,
              )?.id ?? null);
    const activeUserMessageId =
        model.activeCommandId === null
            ? null
            : (model.messages.findLast((message) => message.role === "user")?.id ?? null);
    return {
        activeMessageId,
        activeUserMessageId,
        busy,
        compactAvailable,
        compactDisabled:
            model.connection.kind !== "ready" ||
            model.operation.kind !== "idle" ||
            tasks.operation.kind !== "idle" ||
            !compactAvailable,
        composerError:
            model.operation.kind === "failed"
                ? model.operation.message
                : delivery.state.kind === "failed"
                  ? delivery.state.message
                  : tasks.feedback.kind === "failed"
                    ? tasks.feedback.message
                    : queue.feedback.kind === "failed"
                      ? queue.feedback.message
                      : "",
        controlRunning,
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

export function createSessionPaneModel(options: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "steerTurn" | "submitTurn">;
    readonly storage: Storage;
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
}) {
    const { session, botId, requests } = options;
    const sessionId = session.result.ready.sessionId;
    let client: MobiusClient | null = null;
    let command =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? session.result.activeTurn.commandId
            : "";
    const delivery = createSessionDeliveryStore({
        sessionId,
        storage: options.storage,
        submit: async (request, signal) => await requests.submitTurn(botId, sessionId, request, signal),
    });
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
                return await client.turns.submit(sessionId, request, signal);
            },
        },
    });
    if (session.result.action === "conversation" && session.result.activeTurn.kind === "running") {
        tasks.getState().start(session.result.activeTurn.commandId, session.result.activeTurn.turnId);
    }
    const remoteAccess = createRemoteAccessStore(options.endRemoteAccess);
    const messageQueue = createSessionMessageQueueStore({
        cancel: async (turnId, idempotencyKey, signal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
        },
        steer: async (turnId, signal) => await requests.steerTurn(botId, sessionId, turnId, signal),
        submit: async (request, signal) => {
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            return await client.turns.submit(sessionId, request, signal);
        },
    });
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };

    const store = createStore<SessionPaneStore>()((set, get) => {
        const applyAuthoritativeInteraction = (interaction: ServiceInteraction): void => {
            set((current) => ({
                interactions: replaceInteraction(
                    current.interactions,
                    interaction.interactionId,
                    presentInteraction(interaction),
                ),
            }));
        };
        const reconcileInteraction = async (id: string, cause: unknown, signal: AbortSignal): Promise<void> => {
            signal.throwIfAborted();
            if (client === null) {
                throw new Error("The Session is not connected.");
            }
            try {
                const interaction = await client.interactions.read(
                    sessionId,
                    id,
                    AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                );
                applyAuthoritativeInteraction(interaction);
                if (interaction.state.kind === "pending") {
                    throw cause;
                }
            } catch (reconciliationCause) {
                signal.throwIfAborted();
                throw reconciliationCause === cause ? cause : reconciliationCause;
            }
        };
        return {
            connection: { kind: "loading" },
            messages: historySessionMessages(session.result.history),
            options: session.result.ready.configOptions,
            draft: "",
            attachments: [],
            activities: new Map(),
            interactions: [],
            operation: { kind: "idle" },
            activeCommandId: command || null,
            connect: async (signal) => {
                let lastSequence = 0n;
                const refresh = async () => {
                    if (client === null || command === "") {
                        return;
                    }
                    const currentCommand = command;
                    const page = await client.sessions.readMessages(sessionId, new MobiusPageRequest(100, ""), signal);
                    signal.throwIfAborted();
                    lastSequence = BigInt(page.lastCommittedSequence);
                    const message = page.messages.find((item) => item.commandId === currentCommand);
                    if (message === undefined || command !== currentCommand) {
                        return;
                    }
                    set((current) => {
                        const replies = current.messages.filter(
                            (item) => item.role === "assistant" && item.commandId === currentCommand,
                        );
                        const onlyReplyId = replies.length === 1 ? replies[0]?.id : undefined;
                        return {
                            messages: current.messages.map((item) =>
                                item.role === "assistant" && item.commandId === currentCommand
                                    ? {
                                          ...item,
                                          attempt: message.attempt,
                                          text: item.id === onlyReplyId ? message.response : item.text,
                                      }
                                    : item,
                            ),
                        };
                    });
                    if (["succeeded", "failed", "cancelled", "indeterminate"].includes(message.attempt.kind)) {
                        set({ operation: { kind: "idle" }, activeCommandId: null });
                        tasks.getState().finish(currentCommand);
                        command = "";
                    }
                };
                try {
                    client = await requests.connectSession(botId, sessionId, signal);
                    const connected = client;
                    signal.addEventListener("abort", () => connected.close(), { once: true });
                    const [saved, pendingInteractions] = await Promise.all([
                        connected.sessions.readMessages(sessionId, new MobiusPageRequest(100, ""), signal),
                        connected.interactions.listPending(sessionId, signal),
                    ]);
                    signal.throwIfAborted();
                    set({
                        interactions: pendingInteractions.flatMap((interaction) => {
                            const presented = presentInteraction(interaction);
                            return presented === null ? [] : [presented];
                        }),
                    });
                    delivery.getState().reconcile(saved.messages.map((message) => message.commandId));
                    const restored = restoreSessionPresentation(saved, session.result.history);
                    lastSequence = restored.lastSequence;
                    if (restored.activeCommandId === null) {
                        if (command !== "") {
                            tasks.getState().finish(command);
                        }
                        command = "";
                    } else {
                        command = restored.activeCommandId;
                    }
                    signal.throwIfAborted();
                    set({
                        activities: restored.activities,
                        messages: restored.messages,
                        activeCommandId: command || null,
                    });
                    const subscription = await connected.events.subscribe(
                        sessionId,
                        restored.eventCursor,
                        {
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
                                        const permission = decodeSessionPermissionRequestedEvent(
                                            payload.encodedPayload,
                                        );
                                        set((current) => ({
                                            interactions: replaceInteraction(
                                                current.interactions,
                                                permission.interactionId,
                                                { kind: "permission", permission },
                                            ),
                                        }));
                                    } else if (payload.kind === "session.permission.resolved") {
                                        const resolved = decodeSessionPermissionResolvedEvent(payload.encodedPayload);
                                        set((current) => ({
                                            interactions: replaceInteraction(
                                                current.interactions,
                                                resolved.interactionId,
                                                null,
                                            ),
                                        }));
                                    } else if (payload.kind === "session.elicitation.requested") {
                                        const elicitation = decodeSessionElicitationRequestedEvent(
                                            payload.encodedPayload,
                                        );
                                        set((current) => ({
                                            interactions: replaceInteraction(
                                                current.interactions,
                                                elicitation.interactionId,
                                                { kind: "elicitation", elicitation },
                                            ),
                                        }));
                                    } else if (payload.kind === "session.elicitation.resolved") {
                                        const resolved = decodeSessionElicitationResolvedEvent(payload.encodedPayload);
                                        set((current) => ({
                                            interactions: replaceInteraction(
                                                current.interactions,
                                                resolved.interactionId,
                                                null,
                                            ),
                                        }));
                                    }
                                }
                                if (
                                    command !== "" &&
                                    payload instanceof MobiusControlEvent &&
                                    [
                                        "session.permission.requested",
                                        "session.permission.resolved",
                                        "session.elicitation.requested",
                                        "session.elicitation.resolved",
                                    ].includes(payload.kind) &&
                                    BigInt(event.sequence) > lastSequence
                                ) {
                                    await refresh();
                                    return true;
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
                                        set((current) => ({
                                            activeCommandId: queued.commandId,
                                            messages: [
                                                ...current.messages,
                                                {
                                                    id: `${queued.commandId}-user`,
                                                    role: "user",
                                                    text: queued.summary,
                                                    contents: [],
                                                },
                                                {
                                                    activityIds: [],
                                                    id: `${queued.commandId}-reply`,
                                                    role: "assistant",
                                                    text: "",
                                                    attempt: new MobiusRunningAttemptSummary(
                                                        payload.attemptId,
                                                        event.recordedAt,
                                                    ),
                                                    commandId: queued.commandId,
                                                    contents: [],
                                                },
                                            ],
                                        }));
                                        return true;
                                    }
                                }
                                if (
                                    command === "" ||
                                    !("commandId" in payload) ||
                                    payload.commandId !== command ||
                                    BigInt(event.sequence) <= lastSequence
                                ) {
                                    return true;
                                }
                                lastSequence = BigInt(event.sequence);
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
                                    set((current) => ({
                                        messages: current.messages.map((item) =>
                                            item.role === "assistant" && item.commandId === command
                                                ? {
                                                      ...item,
                                                      attempt: new MobiusRunningAttemptSummary(
                                                          payload.attemptId,
                                                          event.recordedAt,
                                                      ),
                                                  }
                                                : item,
                                        ),
                                    }));
                                } else if (
                                    payload instanceof MobiusTurnCompletedEvent ||
                                    payload instanceof MobiusTurnFailedEvent
                                ) {
                                    await refresh();
                                }
                                return true;
                            },
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    set({ connection: { kind: "ready", client: connected } });
                    await subscription.completed;
                    signal.throwIfAborted();
                    throw new Error("Session updates disconnected. Reopen the Session to continue.");
                } catch (cause) {
                    client?.close();
                    client = null;
                    if (!signal.aborted) {
                        set({
                            connection: { kind: "failed" },
                            operation: {
                                kind: "failed",
                                message: cause instanceof Error ? cause.message : "The Session could not be opened.",
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
                const commandId = crypto.randomUUID();
                command = commandId;
                const prompt = current.draft.trim();
                const displayPrompt =
                    prompt ||
                    current.attachments
                        .map((attachment) =>
                            attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                        )
                        .join(", ");
                set((state) => ({
                    draft: "",
                    attachments: [],
                    activeCommandId: commandId,
                    operation: { kind: "sending", commandId },
                    messages: [
                        ...state.messages,
                        { id: commandId, role: "user", text: displayPrompt, contents: [] },
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
                    const accepted = await delivery.getState().submit(
                        commandId,
                        displayPrompt,
                        {
                            ...request,
                            content: prompt,
                            images: current.attachments.flatMap((attachment) =>
                                attachment.kind === "image" ? [attachment.image] : [],
                            ),
                            resources: current.attachments.flatMap((attachment) =>
                                attachment.kind === "resource" ? [attachment.resource] : [],
                            ),
                            artifactIds: [],
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    if (accepted !== null && command === commandId) {
                        tasks.getState().start(commandId, accepted.turnId);
                    }
                    set({ operation: { kind: "idle" } });
                } catch (cause) {
                    signal.throwIfAborted();
                    set({
                        operation: {
                            kind: "failed",
                            message:
                                cause instanceof Error ? cause.message : "The agent could not complete the message.",
                        },
                    });
                }
            },
            retryUnknownDelivery: async (signal) => {
                const state = delivery.getState().state;
                if (get().connection.kind !== "ready" || state.kind !== "delivery-unknown") {
                    return;
                }
                const pending = state.journal;
                command = pending.commandId;
                set((current) => ({
                    activeCommandId: pending.commandId,
                    messages: current.messages.some(
                        (message) => message.role === "assistant" && message.commandId === pending.commandId,
                    )
                        ? current.messages
                        : [
                              ...current.messages,
                              {
                                  id: `${pending.commandId}-user`,
                                  role: "user",
                                  text: pending.displayPrompt,
                                  contents: [],
                              },
                              {
                                  activityIds: [],
                                  id: `${pending.commandId}-reply`,
                                  role: "assistant",
                                  text: "",
                                  attempt: null,
                                  commandId: pending.commandId,
                                  contents: [],
                              },
                          ],
                }));
                const accepted = await delivery.getState().retry(signal);
                signal.throwIfAborted();
                if (accepted !== null) {
                    tasks.getState().start(pending.commandId, accepted.turnId);
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
                        artifactIds: [],
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
                                contents: [],
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
                    { ...request, artifactIds: [], images: [], resources: [] },
                    (commandId, prompt) => {
                        command = commandId;
                        set((state) => ({
                            activeCommandId: commandId,
                            messages: [
                                ...state.messages,
                                { id: `${commandId}-user`, role: "user", text: prompt, contents: [] },
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
                    },
                    signal,
                );
            },
            configure: async (option, value, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    return;
                }
                set({ operation: { kind: "configuring" } });
                try {
                    const result = await client.sessions.updateConfiguration(
                        sessionId,
                        { configId: option.id, value, valueType: option.type, booleanValue: false },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
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
                    applyAuthoritativeInteraction(
                        await client.interactions.respond(
                            sessionId,
                            response.interactionId,
                            new MobiusPermissionResponseRequest("mobius-web", response.outcome, response.optionId),
                            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                        ),
                    );
                } catch (cause) {
                    await reconcileInteraction(response.interactionId, cause, signal);
                }
            },
            respondToElicitation: async (response, signal) => {
                if (client === null || get().connection.kind !== "ready") {
                    throw new Error("The Session is not connected.");
                }
                try {
                    applyAuthoritativeInteraction(
                        await client.interactions.respond(
                            sessionId,
                            response.interactionId,
                            new MobiusElicitationResponseRequest("mobius-web", response.action, response.content),
                            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                        ),
                    );
                } catch (cause) {
                    await reconcileInteraction(response.interactionId, cause, signal);
                }
            },
            stop: async (signal) => await tasks.getState().stop(signal),
            endRemoteAccess: async (signal) => {
                await remoteAccess.getState().end(signal);
                if (remoteAccess.getState().state.kind === "ended") {
                    client?.close();
                    client = null;
                }
            },
        };
    });
    return {
        store,
        delivery,
        messageQueue,
        tasks,
        remoteAccess,
    };
}
