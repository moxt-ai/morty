import {
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
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import type { OpenLocalSession } from "./local-session-dialog.tsx";
import { type LocalMessage, LocalSessionMessage } from "./local-session-message.tsx";

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

export function LocalSessionPane({
    session,
    onBack,
    botId,
    requests,
}: {
    readonly session: OpenLocalSession;
    readonly onBack: () => void;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession">;
}) {
    const [messages, setMessages] = useState<readonly LocalMessage[]>(() =>
        session.result.history.status === "available"
            ? session.result.history.messages.map((message, index): LocalMessage => {
                  const id = `history-${index}`;
                  return message.role === "user"
                      ? { id, role: "user", text: message.text }
                      : { id, role: "assistant", text: message.text, attempt: null, commandId: null };
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
    const turnId = useRef("");
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
    const sessionId = session.result.ready.sessionId;
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
                command.current = "";
                turnId.current = "";
            }
        };
        const open = async () => {
            client = await requests.connectSession(botId, sessionId, controller.signal);
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
            lastSequence = BigInt(saved.lastCommittedSequence);
            const history = session.result.history;
            const initial: readonly LocalMessage[] =
                history.status === "available"
                    ? history.messages.map(
                          (message, index): LocalMessage =>
                              message.role === "user"
                                  ? { id: `history-${index}`, role: "user", text: message.text }
                                  : {
                                        id: `history-${index}`,
                                        role: "assistant",
                                        text: message.text,
                                        attempt: null,
                                        commandId: null,
                                    },
                      )
                    : [];
            setMessages([
                ...initial,
                ...[...saved.messages]
                    .reverse()
                    .filter(
                        (message) =>
                            history.status !== "available" || !history.coveredCommandIds.includes(message.commandId),
                    )
                    .flatMap((message): readonly LocalMessage[] => [
                        { id: `${message.commandId}-user`, role: "user", text: message.prompt },
                        {
                            id: `${message.commandId}-reply`,
                            role: "assistant",
                            text: message.response,
                            attempt: message.attempt,
                            commandId: message.commandId,
                        },
                    ]),
            ]);
            const subscription = await client.events.subscribe(
                sessionId,
                "",
                {
                    receive: async (event) => {
                        const payload = event.payload;
                        if (payload instanceof MobiusAgentActivityEvent) {
                            setActivities((current) => recordAgentActivity(current, event));
                            return true;
                        }
                        if (payload instanceof MobiusControlEvent) {
                            if (payload.kind === "session.permission.requested") {
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
        };
    }, [session, sessionId, botId, requests]);
    const request = {
        additionalDirectoryIds: session.result.ready.additionalDirectories.map((directory) => directory.directoryId),
    };
    const send = async () => {
        if (
            connection.kind !== "ready" ||
            (draft.trim() === "" && attachments.length === 0) ||
            operation.kind === "sending" ||
            operation.kind === "configuring"
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
            { id: commandId, role: "user", text: displayPrompt },
            { id: `${commandId}-reply`, role: "assistant", text: "", attempt: null, commandId },
        ]);
        setOperation({ kind: "sending", commandId });
        try {
            const accepted = await connection.client.turns.submit(
                sessionId,
                {
                    ...request,
                    idempotencyKey: commandId,
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
            if (!lifetime.current.signal.aborted && command.current === commandId) {
                turnId.current = accepted.turnId;
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
    const busy = connection.kind !== "ready" || operation.kind === "sending" || operation.kind === "configuring";
    const activeCommandId = connection.kind === "ready" && operation.kind === "sending" ? operation.commandId : null;
    return (
        <section className="flex min-h-0 min-w-0 flex-1 animate-cloud-enter flex-col motion-reduce:animate-none">
            <div className="flex items-center gap-3 border-b border-border bg-card/80 px-5 py-4 backdrop-blur-sm">
                <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Bot chat">
                    <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0">
                    <h1 className="truncate text-sm font-semibold">
                        {session.result.title || session.entry.title || "Local session"}
                    </h1>
                    <p className="truncate text-xs text-muted-foreground">
                        {session.agentRef} · {session.entry.directoryLabel}
                    </p>
                </div>
            </div>
            <div
                role="log"
                ref={messageList}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
                aria-label="Local session messages"
                className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-6 [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10"
            >
                {session.result.history.status === "unavailable" && (
                    <p className="text-sm text-muted-foreground">This agent does not expose saved message history.</p>
                )}
                {messages.map((message) => (
                    <div key={message.id} className="mx-auto w-full min-w-0 max-w-3xl">
                        <LocalSessionMessage
                            message={message}
                            activities={activities}
                            activeCommandId={activeCommandId}
                            sessionId={sessionId}
                            botId={botId}
                        />
                    </div>
                ))}
                <div className="mx-auto w-full min-w-0 max-w-3xl">
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
                error={operation.kind === "failed" ? operation.message : ""}
                messageLabel="Message local session"
                onAttachmentsChange={setAttachments}
                onDraftChange={setDraft}
                onStop={() => {}}
                onSubmit={() => void send()}
                outputState="idle"
                placeholder="Continue this conversation…"
                submitDisabled={busy || (draft.trim() === "" && attachments.length === 0)}
                submitLabel="Send to local session"
            >
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
                {operation.kind === "configuring" && (
                    <span role="status" className="sr-only">
                        Applying agent settings…
                    </span>
                )}
            </BotChatComposer>
        </section>
    );
}
