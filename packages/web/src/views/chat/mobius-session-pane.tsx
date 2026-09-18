import {
    type AgentDisplayContent,
    decodeAgentContentEvent,
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
    type MobiusSessionEvent,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { type MobiusClient, MobiusPageRequest } from "@moxt-ai/mobius-sdk/browser";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer, type ComposerAttachment } from "../../components/chat/bot-chat-composer.tsx";
import { ChatComposerMoreMenu } from "../../components/chat/chat-composer-more-menu.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { ChatMessageQueue } from "../../components/chat/chat-message-queue.tsx";
import {
    type ElicitationInteraction,
    type ElicitationInteractionResponse,
    type PermissionInteraction,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import {
    agentActivityKey,
    type RecordedAgentActivity,
    recordAgentActivity,
} from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";
import { createRemoteAccessStore } from "../../view-models/chat/remote-access-store.ts";
import { createSessionDeliveryStore } from "../../view-models/chat/session-delivery-store.ts";
import { createSessionMessageQueueStore } from "../../view-models/chat/session-message-queue-store.ts";
import { createSessionTaskControlsStore, findCompactCommand } from "../../view-models/chat/session-task-controls.ts";
import { MobiusSessionMessage, type SessionMessage, type SessionMessageContent } from "./mobius-session-message.tsx";

type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };

type ServiceInteraction = Awaited<ReturnType<MobiusClient["interactions"]["listPending"]>>[number];
type LocalInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

const ACTIVE_ATTEMPT_KINDS: ReadonlySet<string> = new Set(["none", "dispatching", "running", "waiting_input"]);

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

function historyContents(
    images: readonly { readonly data: string; readonly mimeType: string; readonly name: string }[] | undefined,
): readonly SessionMessageContent[] {
    return (images ?? []).map((image, index) => ({
        contentId: `history-image-${index.toString()}`,
        content: {
            artifactId: "",
            data: image.data,
            mimeType: image.mimeType,
            name: image.name,
            newText: "",
            oldText: "",
            path: "",
            terminalId: "",
            text: "",
            type: "image",
            uri: "",
        },
    }));
}

function replaceMessageContent(
    messages: readonly SessionMessage[],
    commandId: string,
    contentId: string,
    content: AgentDisplayContent,
): readonly SessionMessage[] {
    const existing = messages.findIndex(
        (message) =>
            message.role === "assistant" &&
            message.commandId === commandId &&
            message.contents.some((candidate) => candidate.contentId === contentId),
    );
    const target =
        existing >= 0
            ? existing
            : messages.findLastIndex((message) => message.role === "assistant" && message.commandId === commandId);
    return messages.map((message, index) =>
        index === target && message.role === "assistant"
            ? {
                  ...message,
                  contents: [
                      ...message.contents.filter((candidate) => candidate.contentId !== contentId),
                      { contentId, content },
                  ],
              }
            : message,
    );
}

function placeAgentActivity(
    messages: readonly SessionMessage[],
    commandId: string,
    activityId: string,
): readonly SessionMessage[] {
    if (
        messages.some((message) => message.role === "assistant" && message.activityIds.some((id) => id === activityId))
    ) {
        return messages;
    }
    const lastIndex = messages.findLastIndex(
        (message) => message.role === "assistant" && message.commandId === commandId,
    );
    const last = messages[lastIndex];
    if (last === undefined || last.role !== "assistant") {
        return messages;
    }
    if (last.text.length === 0 && last.contents.length === 0) {
        return messages.map((message, index) =>
            index === lastIndex && message.role === "assistant"
                ? { ...message, activityIds: [...message.activityIds, activityId] }
                : message,
        );
    }
    return [
        ...messages.slice(0, lastIndex + 1),
        {
            activityIds: [activityId],
            attempt: last.attempt,
            commandId,
            contents: [],
            id: `${commandId}-reply-${activityId}`,
            role: "assistant",
            text: "",
        },
        ...messages.slice(lastIndex + 1),
    ];
}

function recordedContent(event: MobiusSessionEvent): {
    readonly commandId: string;
    readonly content: AgentDisplayContent;
    readonly contentId: string;
} | null {
    if (!(event.payload instanceof MobiusControlEvent) || event.payload.kind !== "agent.content") {
        return null;
    }
    const decoded = decodeAgentContentEvent(event.payload.encodedPayload);
    return { commandId: decoded.commandId, content: decoded.content, contentId: decoded.contentId };
}

function applyRecordedContents(
    messages: readonly SessionMessage[],
    events: readonly MobiusSessionEvent[],
): readonly SessionMessage[] {
    return events.reduce((current, event) => {
        const recorded = recordedContent(event);
        return recorded === null
            ? current
            : replaceMessageContent(current, recorded.commandId, recorded.contentId, recorded.content);
    }, messages);
}

export function MobiusSessionPane({
    session,
    botId,
    requests,
    initialActiveTurn,
    endRemoteAccess,
}: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "steerTurn" | "submitTurn">;
    readonly initialActiveTurn: { readonly commandId: string; readonly turnId: string } | null;
    readonly endRemoteAccess?: (signal: AbortSignal) => Promise<void>;
}) {
    const sessionId = session.result.ready.sessionId;
    const clientReference = useRef<MobiusClient | null>(null);
    const [deliveryStore] = useState(() =>
        createSessionDeliveryStore({
            sessionId,
            storage: window.localStorage,
            submit: async (request, signal) => {
                return await requests.submitTurn(botId, sessionId, request, signal);
            },
        }),
    );
    const delivery = useStore(deliveryStore);
    const [taskControlsStore] = useState(() => {
        const store = createSessionTaskControlsStore({
            commands: session.result.ready.commands,
            steeringSupported: session.result.ready.capabilities.steering,
            port: {
                cancel: async (turnId, idempotencyKey, signal) => {
                    const client = clientReference.current;
                    if (client === null) {
                        throw new Error("The Session is not connected.");
                    }
                    return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
                },
                submit: async (request, signal) => {
                    const client = clientReference.current;
                    if (client === null) {
                        throw new Error("The Session is not connected.");
                    }
                    return await client.turns.submit(sessionId, request, signal);
                },
            },
        });
        if (session.result.action === "conversation" && session.result.activeTurn.kind === "running") {
            store.getState().start(session.result.activeTurn.commandId, session.result.activeTurn.turnId);
        }
        return store;
    });
    const [remoteAccessStore] = useState(() =>
        createRemoteAccessStore(endRemoteAccess ?? (async () => Promise.resolve())),
    );
    const [messageQueueStore] = useState(() =>
        createSessionMessageQueueStore({
            cancel: async (turnId, idempotencyKey, signal) => {
                const client = clientReference.current;
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal);
            },
            steer: async (turnId, signal) => {
                await requests.steerTurn(botId, sessionId, turnId, signal);
            },
            submit: async (request, signal) => {
                const client = clientReference.current;
                if (client === null) {
                    throw new Error("The Session is not connected.");
                }
                return await client.turns.submit(sessionId, request, signal);
            },
        }),
    );
    const remoteAccess = useStore(remoteAccessStore);
    const messageQueue = useStore(messageQueueStore);
    const taskControls = useStore(taskControlsStore);
    const [messages, setMessages] = useState<readonly SessionMessage[]>(() =>
        session.result.history.status === "available"
            ? session.result.history.messages.map((message, index): SessionMessage => {
                  const id = `history-${index}`;
                  return message.role === "user"
                      ? { id, role: "user", text: message.text, contents: historyContents(message.images) }
                      : {
                            activityIds: [],
                            id,
                            role: "assistant",
                            text: message.text,
                            attempt: null,
                            commandId: null,
                            contents: historyContents(message.images),
                        };
              })
            : [],
    );
    const [options, setOptions] = useState<readonly SessionConfigOption[]>(session.result.ready.configOptions);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
    const [activities, setActivities] = useState<ReadonlyMap<string, RecordedAgentActivity>>(new Map());
    const [interactions, setInteractions] = useState<readonly LocalInteraction[]>([]);
    const [operation, setOperation] = useState<Operation>({ kind: "idle" });
    const lifetime = useRef(new AbortController());
    const command = useRef(
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? session.result.activeTurn.commandId
            : "",
    );
    const [connection, setConnection] = useState<
        | { readonly kind: "loading" }
        | { readonly kind: "ready"; readonly client: MobiusClient }
        | { readonly kind: "failed" }
    >({ kind: "loading" });
    const messageList = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll after rendered message content changes, unless the user is reading older history.
    useEffect(() => {
        if (followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [messages]);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        let client: MobiusClient | null = null;
        let lastSequence = 0n;
        const refresh = async () => {
            if (client === null || command.current === "") {
                return;
            }
            const currentCommand = command.current;
            const page = await client.sessions.readMessages(
                sessionId,
                new MobiusPageRequest(100, ""),
                controller.signal,
            );
            controller.signal.throwIfAborted();
            lastSequence = BigInt(page.lastCommittedSequence);
            const message = page.messages.find((item) => item.commandId === currentCommand);
            if (message === undefined || command.current !== currentCommand) {
                return;
            }
            setMessages((current) => {
                const replies = current.filter(
                    (item) => item.role === "assistant" && item.commandId === currentCommand,
                );
                const onlyReplyId = replies.length === 1 ? replies[0]?.id : undefined;
                return current.map((item) =>
                    item.role === "assistant" && item.commandId === currentCommand
                        ? {
                              ...item,
                              attempt: message.attempt,
                              text: item.id === onlyReplyId ? message.response : item.text,
                          }
                        : item,
                );
            });
            if (["succeeded", "failed", "cancelled", "indeterminate"].includes(message.attempt.kind)) {
                setOperation({ kind: "idle" });
                taskControlsStore.getState().finish(currentCommand);
                command.current = "";
            }
        };
        const open = async () => {
            client = await requests.connectSession(botId, sessionId, controller.signal);
            clientReference.current = client;
            const [saved, pendingInteractions] = await Promise.all([
                client.sessions.readMessages(sessionId, new MobiusPageRequest(100, ""), controller.signal),
                client.interactions.listPending(sessionId, controller.signal),
            ]);
            controller.signal.throwIfAborted();
            setInteractions(
                pendingInteractions.flatMap((interaction) => {
                    const presented = presentInteraction(interaction);
                    return presented === null ? [] : [presented];
                }),
            );
            deliveryStore.getState().reconcile(saved.messages.map((message) => message.commandId));
            if (initialActiveTurn !== null) {
                const initialMessage = saved.messages.find(
                    (message) => message.commandId === initialActiveTurn.commandId,
                );
                if (
                    initialMessage !== undefined &&
                    ["succeeded", "failed", "cancelled", "indeterminate"].includes(initialMessage.attempt.kind)
                ) {
                    taskControlsStore.getState().finish(initialActiveTurn.commandId);
                    command.current = "";
                }
            }
            lastSequence = BigInt(saved.lastCommittedSequence);
            const activeMessage = saved.messages.find((message) => ACTIVE_ATTEMPT_KINDS.has(message.attempt.kind));
            if (activeMessage === undefined) {
                const currentCommand = command.current;
                if (currentCommand !== "") {
                    taskControlsStore.getState().finish(currentCommand);
                    command.current = "";
                }
            } else {
                command.current = activeMessage.commandId;
            }
            const history = session.result.history;
            const initial: readonly SessionMessage[] =
                history.status === "available"
                    ? history.messages.map(
                          (message, index): SessionMessage =>
                              message.role === "user"
                                  ? {
                                        id: `history-${index}`,
                                        role: "user",
                                        text: message.text,
                                        contents: historyContents(message.images),
                                    }
                                  : {
                                        activityIds: [],
                                        id: `history-${index}`,
                                        role: "assistant",
                                        text: message.text,
                                        attempt: null,
                                        commandId: null,
                                        contents: historyContents(message.images),
                                    },
                      )
                    : [];
            const restoredMessages: readonly SessionMessage[] = [
                ...initial,
                ...[...saved.messages]
                    .reverse()
                    .filter(
                        (message) =>
                            history.status !== "available" || !history.coveredCommandIds.includes(message.commandId),
                    )
                    .flatMap((message): readonly SessionMessage[] => [
                        { id: `${message.commandId}-user`, role: "user", text: message.prompt, contents: [] },
                        {
                            activityIds: [],
                            id: `${message.commandId}-reply`,
                            role: "assistant",
                            text: message.response,
                            attempt: message.attempt,
                            commandId: message.commandId,
                            contents: message.contents.map((content, index) => ({
                                contentId: `saved-content-${index.toString()}`,
                                content,
                            })),
                        },
                    ]),
            ];
            controller.signal.throwIfAborted();
            setMessages(restoredMessages);
            const subscription = await client.events.subscribe(
                sessionId,
                saved.tailEventCursor,
                {
                    receive: async (event) => {
                        const payload = event.payload;
                        if (payload instanceof MobiusAgentActivityEvent) {
                            setActivities((current) => recordAgentActivity(current, event));
                            setMessages((current) =>
                                placeAgentActivity(current, payload.commandId, agentActivityKey(payload)),
                            );
                            return true;
                        }
                        if (payload instanceof MobiusControlEvent) {
                            if (payload.kind === "agent.content") {
                                setMessages((current) => applyRecordedContents(current, [event]));
                            } else if (payload.kind === "session.commands.updated") {
                                taskControlsStore
                                    .getState()
                                    .updateCommands(decodeSessionCommandsUpdatedEvent(payload.encodedPayload).commands);
                            } else if (payload.kind === "session.permission.requested") {
                                const permission = decodeSessionPermissionRequestedEvent(payload.encodedPayload);
                                setInteractions((current) =>
                                    replaceInteraction(current, permission.interactionId, {
                                        kind: "permission",
                                        permission,
                                    }),
                                );
                            } else if (payload.kind === "session.permission.resolved") {
                                const resolved = decodeSessionPermissionResolvedEvent(payload.encodedPayload);
                                setInteractions((current) => replaceInteraction(current, resolved.interactionId, null));
                            } else if (payload.kind === "session.elicitation.requested") {
                                const elicitation = decodeSessionElicitationRequestedEvent(payload.encodedPayload);
                                setInteractions((current) =>
                                    replaceInteraction(current, elicitation.interactionId, {
                                        kind: "elicitation",
                                        elicitation,
                                    }),
                                );
                            } else if (payload.kind === "session.elicitation.resolved") {
                                const resolved = decodeSessionElicitationResolvedEvent(payload.encodedPayload);
                                setInteractions((current) => replaceInteraction(current, resolved.interactionId, null));
                            }
                        }
                        if (
                            command.current !== "" &&
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
                            messageQueueStore
                                .getState()
                                .messages.some((message) => message.commandId === payload.commandId)
                        ) {
                            const queued = messageQueueStore.getState().takeStarted(payload.commandId);
                            if (queued !== null) {
                                const previousCommand = command.current;
                                if (previousCommand !== "") {
                                    taskControlsStore.getState().finish(previousCommand);
                                }
                                command.current = queued.commandId;
                                taskControlsStore.getState().start(queued.commandId, queued.turnId);
                                setMessages((current) => [
                                    ...current,
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
                                        attempt: new MobiusRunningAttemptSummary(payload.attemptId, event.recordedAt),
                                        commandId: queued.commandId,
                                        contents: [],
                                    },
                                ]);
                                return true;
                            }
                        }
                        if (
                            command.current === "" ||
                            !("commandId" in payload) ||
                            payload.commandId !== command.current
                        ) {
                            return true;
                        }
                        if (BigInt(event.sequence) <= lastSequence) {
                            return true;
                        }
                        lastSequence = BigInt(event.sequence);
                        if (payload instanceof MobiusAgentMessageEvent) {
                            setMessages((current) => {
                                const target = current.findLastIndex(
                                    (item) => item.role === "assistant" && item.commandId === command.current,
                                );
                                return current.map((item, index) =>
                                    index === target && item.role === "assistant"
                                        ? { ...item, text: item.text + payload.text }
                                        : item,
                                );
                            });
                        } else if (payload instanceof MobiusTurnStartedEvent) {
                            setMessages((current) =>
                                current.map((item) =>
                                    item.role === "assistant" && item.commandId === command.current
                                        ? {
                                              ...item,
                                              attempt: new MobiusRunningAttemptSummary(
                                                  payload.attemptId,
                                                  event.recordedAt,
                                              ),
                                          }
                                        : item,
                                ),
                            );
                        } else if (
                            payload instanceof MobiusTurnCompletedEvent ||
                            payload instanceof MobiusTurnFailedEvent
                        ) {
                            await refresh();
                        }
                        return true;
                    },
                },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            setConnection({ kind: "ready", client });
            await subscription.completed;
            controller.signal.throwIfAborted();
            throw new Error("Session updates disconnected. Reopen the Session to continue.");
        };
        void open().catch((cause: unknown) => {
            client?.close();
            clientReference.current = null;
            if (!controller.signal.aborted) {
                setConnection({ kind: "failed" });
                setOperation({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The Session could not be opened.",
                });
            }
        });
        return () => {
            controller.abort();
            client?.close();
            clientReference.current = null;
        };
    }, [session, sessionId, botId, requests, initialActiveTurn, taskControlsStore, deliveryStore, messageQueueStore]);
    useEffect(() => {
        if (remoteAccess.state.kind === "ended") {
            lifetime.current.abort();
            clientReference.current?.close();
            clientReference.current = null;
        }
    }, [remoteAccess.state.kind]);
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };
    const send = async () => {
        if (
            connection.kind !== "ready" ||
            (draft.trim() === "" && attachments.length === 0) ||
            operation.kind === "sending" ||
            operation.kind === "configuring" ||
            taskControls.operation.kind !== "idle"
        ) {
            return;
        }
        const commandId = crypto.randomUUID();
        command.current = commandId;
        const prompt = draft.trim();
        const displayPrompt =
            prompt ||
            attachments
                .map((attachment) => (attachment.kind === "image" ? attachment.image.name : attachment.resource.name))
                .join(", ");
        followLatest.current = true;
        setDraft("");
        setAttachments([]);
        setMessages((current) => [
            ...current,
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
        ]);
        setOperation({ kind: "sending", commandId });
        try {
            const accepted = await deliveryStore.getState().submit(
                commandId,
                displayPrompt,
                {
                    ...request,
                    content: prompt,
                    images: attachments.flatMap((attachment) =>
                        attachment.kind === "image" ? [attachment.image] : [],
                    ),
                    resources: attachments.flatMap((attachment) =>
                        attachment.kind === "resource" ? [attachment.resource] : [],
                    ),
                    artifactIds: [],
                },
                lifetime.current.signal,
            );
            if (accepted !== null && !lifetime.current.signal.aborted && command.current === commandId) {
                taskControlsStore.getState().start(commandId, accepted.turnId);
                setOperation({ kind: "idle" });
            } else if (!lifetime.current.signal.aborted) {
                setOperation({ kind: "idle" });
            }
        } catch (cause) {
            if (!lifetime.current.signal.aborted) {
                setOperation({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The agent could not complete the message.",
                });
            }
        }
    };
    const retryUnknownDelivery = async () => {
        if (connection.kind !== "ready" || delivery.state.kind !== "delivery-unknown") {
            return;
        }
        const pending = delivery.state.journal;
        command.current = pending.commandId;
        setMessages((current) =>
            current.some((message) => message.role === "assistant" && message.commandId === pending.commandId)
                ? current
                : [
                      ...current,
                      { id: `${pending.commandId}-user`, role: "user", text: pending.displayPrompt, contents: [] },
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
        );
        const accepted = await deliveryStore.getState().retry(lifetime.current.signal);
        if (accepted !== null && !lifetime.current.signal.aborted) {
            taskControlsStore.getState().start(pending.commandId, accepted.turnId);
        }
    };
    const queueDraft = async () => {
        const controls = taskControlsStore.getState();
        if (connection.kind !== "ready" || controls.operation.kind !== "running") {
            return;
        }
        const prompt = draft.trim();
        const selectedAttachments = attachments;
        const summary =
            prompt ||
            selectedAttachments
                .map((attachment) => (attachment.kind === "image" ? attachment.image.name : attachment.resource.name))
                .join(", ");
        const queued = await messageQueueStore.getState().enqueue(
            controls.operation.active.commandId,
            summary,
            {
                ...request,
                content: prompt,
                images: selectedAttachments.flatMap((attachment) =>
                    attachment.kind === "image" ? [attachment.image] : [],
                ),
                resources: selectedAttachments.flatMap((attachment) =>
                    attachment.kind === "resource" ? [attachment.resource] : [],
                ),
                artifactIds: [],
            },
            lifetime.current.signal,
        );
        if (queued !== null && !lifetime.current.signal.aborted) {
            setDraft("");
            setAttachments([]);
        }
    };
    const steerQueued = async (commandId: string) => {
        const steered = await messageQueueStore.getState().steerMessage(commandId, lifetime.current.signal);
        if (steered !== null && !lifetime.current.signal.aborted) {
            followLatest.current = true;
            setMessages((current) => [
                ...current,
                { id: `${steered.commandId}-user`, role: "user", text: steered.summary, contents: [] },
            ]);
        }
    };
    const compact = async () => {
        if (connection.kind !== "ready") {
            return;
        }
        await taskControlsStore.getState().compact(
            { ...request, artifactIds: [], images: [], resources: [] },
            (commandId, prompt) => {
                command.current = commandId;
                followLatest.current = true;
                setMessages((current) => [
                    ...current,
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
                ]);
            },
            lifetime.current.signal,
        );
    };
    const configure = async (option: SessionConfigOption, value: string) => {
        if (connection.kind !== "ready") {
            return;
        }
        setOperation({ kind: "configuring" });
        try {
            const result = await connection.client.sessions.updateConfiguration(
                sessionId,
                { configId: option.id, value, valueType: option.type, booleanValue: false },
                AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(45000)]),
            );
            if (!lifetime.current.signal.aborted) {
                setOptions(result.configOptions);
                setOperation({ kind: "idle" });
            }
        } catch (cause) {
            if (!lifetime.current.signal.aborted) {
                setOperation({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The selection could not be applied.",
                });
            }
        }
    };
    const applyAuthoritativeInteraction = (interaction: ServiceInteraction): void => {
        setInteractions((current) =>
            replaceInteraction(current, interaction.interactionId, presentInteraction(interaction)),
        );
    };
    const reconcileInteraction = async (client: MobiusClient, id: string, cause: unknown): Promise<void> => {
        lifetime.current.signal.throwIfAborted();
        try {
            const interaction = await client.interactions.read(
                sessionId,
                id,
                AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(20_000)]),
            );
            applyAuthoritativeInteraction(interaction);
            if (interaction.state.kind === "pending") {
                throw cause;
            }
        } catch (reconciliationCause) {
            lifetime.current.signal.throwIfAborted();
            throw reconciliationCause === cause ? cause : reconciliationCause;
        }
    };
    const respondToLocalPermission = async (response: PermissionInteractionResponse): Promise<void> => {
        if (connection.kind !== "ready") {
            throw new Error("The Session is not connected.");
        }
        try {
            applyAuthoritativeInteraction(
                await connection.client.interactions.respond(
                    sessionId,
                    response.interactionId,
                    new MobiusPermissionResponseRequest("mobius-web", response.outcome, response.optionId),
                    AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(20_000)]),
                ),
            );
        } catch (cause) {
            await reconcileInteraction(connection.client, response.interactionId, cause);
        }
    };
    const respondToLocalElicitation = async (response: ElicitationInteractionResponse): Promise<void> => {
        if (connection.kind !== "ready") {
            throw new Error("The Session is not connected.");
        }
        try {
            applyAuthoritativeInteraction(
                await connection.client.interactions.respond(
                    sessionId,
                    response.interactionId,
                    new MobiusElicitationResponseRequest("mobius-web", response.action, response.content),
                    AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(20_000)]),
                ),
            );
        } catch (cause) {
            await reconcileInteraction(connection.client, response.interactionId, cause);
        }
    };
    const activeControl =
        taskControls.operation.kind === "running" ||
        taskControls.operation.kind === "steering" ||
        taskControls.operation.kind === "stopping"
            ? taskControls.operation
            : null;
    const controlRunning = activeControl !== null;
    const busy =
        connection.kind !== "ready" ||
        command.current !== "" ||
        delivery.state.kind === "submitting" ||
        delivery.state.kind === "delivery-unknown" ||
        operation.kind === "sending" ||
        operation.kind === "configuring" ||
        taskControls.operation.kind === "compacting" ||
        messageQueue.operation.kind === "submitting" ||
        taskControls.operation.kind === "steering" ||
        taskControls.operation.kind === "stopping";
    const activeCommandId =
        connection.kind !== "ready"
            ? null
            : operation.kind === "sending"
              ? operation.commandId
              : activeControl !== null
                ? activeControl.active.commandId
                : taskControls.operation.kind === "compacting"
                  ? taskControls.operation.commandId
                  : command.current || null;
    const activeMessageId =
        activeCommandId === null
            ? null
            : (messages.findLast((message) => message.role === "assistant" && message.commandId === activeCommandId)
                  ?.id ?? null);
    const activeUserMessageId =
        activeCommandId === null ? null : (messages.findLast((message) => message.role === "user")?.id ?? null);
    const compactAvailable = findCompactCommand(taskControls.commands) !== null;
    const taskControlError =
        taskControls.feedback.kind === "failed"
            ? taskControls.feedback.message
            : messageQueue.feedback.kind === "failed"
              ? messageQueue.feedback.message
              : "";
    if (endRemoteAccess !== undefined && remoteAccess.state.kind === "ended") {
        return (
            <section className="m-auto grid max-w-lg gap-3 p-8 text-center">
                <h1 className="text-2xl font-semibold">Remote access ended</h1>
                <p>Your local task is still running on your computer. This browser can no longer open it.</p>
            </section>
        );
    }
    return (
        <section className="flex min-h-0 min-w-0 flex-1 animate-cloud-enter flex-col motion-reduce:animate-none">
            {endRemoteAccess !== undefined && (
                <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-2">
                    {remoteAccess.state.kind === "confirming" ? (
                        <>
                            <span className="text-sm">End access for every remote browser?</span>
                            <Button
                                variant="destructive"
                                disabled={false}
                                onClick={() => void remoteAccessStore.getState().end(lifetime.current.signal)}
                            >
                                Confirm end access
                            </Button>
                            <Button variant="ghost" onClick={remoteAccessStore.getState().cancelEnd}>
                                Cancel
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="outline"
                            disabled={remoteAccess.state.kind === "ending"}
                            onClick={remoteAccessStore.getState().requestEnd}
                        >
                            {remoteAccess.state.kind === "ending" ? "Ending remote access…" : "End remote access"}
                        </Button>
                    )}
                    {remoteAccess.state.kind === "failed" && <p role="alert">{remoteAccess.state.message}</p>}
                </div>
            )}
            <div
                role="log"
                ref={messageList}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
                aria-label="Messages"
                className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-6 [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10"
            >
                {session.result.history.status === "unavailable" && (
                    <p className="text-sm text-muted-foreground">This agent does not expose saved message history.</p>
                )}
                {messages.map((message) => {
                    const workingOnly =
                        message.role === "assistant" &&
                        message.id === activeMessageId &&
                        message.text.length === 0 &&
                        message.activityIds.length === 0 &&
                        message.contents.length === 0;
                    return (
                        <div
                            key={message.id}
                            className={`mx-auto w-full min-w-0 max-w-[1120px] ${workingOnly ? "hidden" : ""}`}
                        >
                            <MobiusSessionMessage
                                message={message}
                                activities={activities}
                                activeCommandId={activeCommandId}
                                activeMessageId={activeMessageId}
                                activeUserMessageId={activeUserMessageId}
                                sessionId={sessionId}
                                botId={botId}
                                client={connection.kind === "ready" ? connection.client : null}
                            />
                        </div>
                    );
                })}
                <div className="mx-auto w-full min-w-0 max-w-[1120px]">
                    <SessionInteractionCards
                        elicitations={interactions.flatMap((interaction) =>
                            interaction.kind === "elicitation" ? [interaction.elicitation] : [],
                        )}
                        permissions={interactions.flatMap((interaction) =>
                            interaction.kind === "permission" ? [interaction.permission] : [],
                        )}
                        onElicitationResponse={respondToLocalElicitation}
                        onPermissionResponse={respondToLocalPermission}
                    />
                </div>
            </div>
            <ChatMessageQueue
                messages={messageQueue.messages}
                steeringSupported={taskControls.steeringSupported}
                onDelete={(commandId) =>
                    void messageQueueStore.getState().deleteMessage(commandId, lifetime.current.signal)
                }
                onSteer={(commandId) => void steerQueued(commandId)}
            />
            <BotChatComposer
                actions={
                    <ChatComposerMoreMenu
                        compactAvailable={compactAvailable}
                        compactDisabled={
                            connection.kind !== "ready" ||
                            operation.kind !== "idle" ||
                            taskControls.operation.kind !== "idle"
                        }
                        onCompact={() => void compact()}
                    />
                }
                attachments={attachments}
                disabled={busy}
                draft={draft}
                error={
                    operation.kind === "failed"
                        ? operation.message
                        : delivery.state.kind === "failed"
                          ? delivery.state.message
                          : taskControlError
                }
                onAttachmentsChange={setAttachments}
                onDraftChange={(value) => {
                    taskControlsStore.getState().dismissFailure();
                    messageQueueStore.getState().dismissFailure();
                    setDraft(value);
                }}
                onStop={() => void taskControlsStore.getState().stop(lifetime.current.signal)}
                onSubmit={() => void (taskControls.operation.kind === "running" ? queueDraft() : send())}
                outputState={
                    messageQueue.operation.kind === "submitting"
                        ? "sending"
                        : taskControls.operation.kind === "stopping"
                          ? "stopping"
                          : operation.kind === "sending" || delivery.state.kind === "submitting"
                            ? "sending"
                            : controlRunning
                              ? "running"
                              : "idle"
                }
                submitDisabled={
                    (taskControls.operation.kind === "running" ? messageQueue.operation.kind !== "idle" : busy) ||
                    (draft.trim() === "" && attachments.length === 0)
                }
            >
                {delivery.state.kind === "delivery-unknown" && (
                    <div role="alert" className="flex items-center gap-2 text-sm">
                        <span>Delivery unknown. This message will not be sent again automatically.</span>
                        <Button variant="outline" size="sm" onClick={() => void retryUnknownDelivery()}>
                            Retry same message
                        </Button>
                    </div>
                )}
                <ChatConfigurationMenu
                    controls={[
                        {
                            disabled: true,
                            id: "harness",
                            label: "Harness",
                            onValueChange: () => {},
                            options: [{ value: session.agentRef, label: session.agentRef }],
                            value: session.agentRef,
                        },
                        ...options
                            .filter(
                                (option) =>
                                    ["model", "thought_level", "model_config"].includes(option.category) &&
                                    option.type !== "boolean",
                            )
                            .map((option) => ({
                                disabled: busy,
                                id: option.id,
                                label: option.category === "model" ? "Model" : "Variant",
                                onValueChange: (value: string) => void configure(option, value),
                                options: option.values.map((value) => ({ value: value.value, label: value.name })),
                                value: option.currentValue,
                            })),
                    ]}
                />
                {operation.kind === "configuring" && (
                    <span role="status" className="sr-only">
                        Applying agent settings…
                    </span>
                )}
            </BotChatComposer>
        </section>
    );
}
