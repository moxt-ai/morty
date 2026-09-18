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
import {
    type ElicitationInteraction,
    type ElicitationInteractionResponse,
    type PermissionInteraction,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { type RecordedAgentActivity, recordAgentActivity } from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";
import { createRemoteAccessStore } from "../../view-models/chat/remote-access-store.ts";
import { createSessionDeliveryStore } from "../../view-models/chat/session-delivery-store.ts";
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
    return messages.map((message) => {
        if (message.role !== "assistant" || message.commandId !== commandId) {
            return message;
        }
        return {
            ...message,
            contents: [
                ...message.contents.filter((candidate) => candidate.contentId !== contentId),
                { contentId, content },
            ],
        };
    });
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
    endRemoteAccess,
}: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "submitTurn">;
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
    const [taskControlsStore] = useState(() =>
        createSessionTaskControlsStore({
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
        }),
    );
    const [remoteAccessStore] = useState(() =>
        createRemoteAccessStore(endRemoteAccess ?? (async () => Promise.resolve())),
    );
    const remoteAccess = useStore(remoteAccessStore);
    const taskControls = useStore(taskControlsStore);
    const [messages, setMessages] = useState<readonly SessionMessage[]>(() =>
        session.result.history.status === "available"
            ? session.result.history.messages.map((message, index): SessionMessage => {
                  const id = `history-${index}`;
                  return message.role === "user"
                      ? { id, role: "user", text: message.text, contents: historyContents(message.images) }
                      : {
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
    const command = useRef("");
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
            setMessages((current) =>
                current.map((item) =>
                    item.role === "assistant" && item.commandId === currentCommand
                        ? { ...item, text: message.response, attempt: message.attempt }
                        : item,
                ),
            );
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
            lastSequence = BigInt(saved.lastCommittedSequence);
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
                        const replyId = `${command.current}-reply`;
                        if (payload instanceof MobiusAgentMessageEvent) {
                            setMessages((current) =>
                                current.map((item) =>
                                    item.role === "assistant" && item.id === replyId
                                        ? { ...item, text: item.text + payload.text }
                                        : item,
                                ),
                            );
                        } else if (payload instanceof MobiusTurnStartedEvent) {
                            setMessages((current) =>
                                current.map((item) =>
                                    item.role === "assistant" && item.id === replyId
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
    }, [session, sessionId, botId, requests, taskControlsStore, deliveryStore]);
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
            { id: `${commandId}-reply`, role: "assistant", text: "", attempt: null, commandId, contents: [] },
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
    const steer = async () => {
        if (connection.kind !== "ready") {
            return;
        }
        const prompt = draft.trim();
        const selectedAttachments = attachments;
        await taskControlsStore.getState().steer(
            prompt,
            {
                ...request,
                images: selectedAttachments.flatMap((attachment) =>
                    attachment.kind === "image" ? [attachment.image] : [],
                ),
                resources: selectedAttachments.flatMap((attachment) =>
                    attachment.kind === "resource" ? [attachment.resource] : [],
                ),
                artifactIds: [],
            },
            (commandId, content) => {
                followLatest.current = true;
                setDraft("");
                setAttachments([]);
                setMessages((current) => [
                    ...current,
                    { id: `${commandId}-user`, role: "user", text: content, contents: [] },
                ]);
            },
            lifetime.current.signal,
        );
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
                    { id: `${commandId}-reply`, role: "assistant", text: "", attempt: null, commandId, contents: [] },
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
        delivery.state.kind === "submitting" ||
        delivery.state.kind === "delivery-unknown" ||
        operation.kind === "sending" ||
        operation.kind === "configuring" ||
        taskControls.operation.kind === "compacting" ||
        taskControls.operation.kind === "steering" ||
        taskControls.operation.kind === "stopping" ||
        (taskControls.operation.kind === "running" && !taskControls.steeringSupported);
    const activeCommandId =
        connection.kind !== "ready"
            ? null
            : operation.kind === "sending"
              ? operation.commandId
              : activeControl !== null
                ? activeControl.active.commandId
                : taskControls.operation.kind === "compacting"
                  ? taskControls.operation.commandId
                  : null;
    const compactAvailable = findCompactCommand(taskControls.commands) !== null;
    const taskControlError = taskControls.feedback.kind === "failed" ? taskControls.feedback.message : "";
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
                {messages.map((message) => (
                    <div key={message.id} className="mx-auto w-full min-w-0 max-w-[1120px]">
                        <MobiusSessionMessage
                            message={message}
                            activities={activities}
                            activeCommandId={activeCommandId}
                            sessionId={sessionId}
                            botId={botId}
                            client={connection.kind === "ready" ? connection.client : null}
                        />
                    </div>
                ))}
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
            <BotChatComposer
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
                    setDraft(value);
                }}
                onStop={() => void taskControlsStore.getState().stop(lifetime.current.signal)}
                onSubmit={() =>
                    void (taskControls.operation.kind === "running" && taskControls.steeringSupported
                        ? steer()
                        : send())
                }
                outputState={
                    taskControls.operation.kind === "stopping" ? "stopping" : controlRunning ? "running" : "idle"
                }
                submitDisabled={
                    (taskControls.operation.kind !== "running" && busy) ||
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
                <Select
                    compact
                    label="Harness"
                    value={session.agentRef}
                    disabled
                    options={[{ value: session.agentRef, label: session.agentRef }]}
                    onValueChange={() => {}}
                />
                {options
                    .filter(
                        (option) =>
                            ["model", "thought_level", "model_config"].includes(option.category) &&
                            option.type !== "boolean",
                    )
                    .map((option) => (
                        <Select
                            compact
                            key={option.id}
                            label={option.category === "model" ? "Model" : "Variant"}
                            value={option.currentValue}
                            options={option.values.map((value) => ({ value: value.value, label: value.name }))}
                            disabled={busy}
                            onValueChange={(value) => void configure(option, value)}
                        />
                    ))}
                {controlRunning && taskControls.steeringSupported && (
                    <Button
                        aria-label="Steer active task"
                        disabled={taskControls.operation.kind !== "running" || draft.trim() === ""}
                        onClick={() => void steer()}
                        size="sm"
                        variant="outline"
                    >
                        Steer
                    </Button>
                )}
                {controlRunning && !taskControls.steeringSupported && (
                    <span className="whitespace-nowrap text-xs text-muted-foreground">Steering unavailable</span>
                )}
                <Button
                    aria-label="Compact context"
                    disabled={
                        connection.kind !== "ready" ||
                        operation.kind !== "idle" ||
                        taskControls.operation.kind !== "idle" ||
                        !compactAvailable
                    }
                    onClick={() => void compact()}
                    size="sm"
                    title={
                        compactAvailable
                            ? "Compact the agent context"
                            : "This agent does not provide a compact command."
                    }
                    variant="outline"
                >
                    {compactAvailable ? "Compact" : "Compact unavailable"}
                </Button>
                {operation.kind === "configuring" && (
                    <span role="status" className="sr-only">
                        Applying agent settings…
                    </span>
                )}
            </BotChatComposer>
        </section>
    );
}
