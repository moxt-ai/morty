import {
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    MobiusControlEvent,
    MobiusRunningAttemptSummary,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk";
import { type MobiusClient, MobiusPageRequest } from "@moxt-ai/mobius-sdk/browser";
import { ArrowLeft, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ComposerSurface } from "../../components/chat/composer-surface.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { type RecordedAgentActivity, recordAgentActivity } from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { type LocalMessage, LocalSessionMessage } from "./local-session-message.tsx";
import type { OpenLocalSession } from "./local-session-sidebar.tsx";

type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };

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
    const [options, setOptions] = useState<readonly SessionConfigOption[]>(
        session.result.action === "preview" ? [] : session.result.ready.configOptions,
    );
    const [draft, setDraft] = useState("");
    const [activities, setActivities] = useState<ReadonlyMap<string, RecordedAgentActivity>>(new Map());
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
    const sessionId =
        session.result.action === "preview" ? session.result.targetSessionId : session.result.ready.sessionId;
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
            if (session.result.action === "preview") {
                return;
            }
            client = await requests.connectSession(botId, sessionId, controller.signal);
            controller.signal.throwIfAborted();
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
            const currentClient = client;
            if (currentClient !== null && turnId.current !== "") {
                void currentClient.turns
                    .cancel(
                        sessionId,
                        turnId.current,
                        { idempotencyKey: crypto.randomUUID() },
                        AbortSignal.timeout(15000),
                    )
                    .catch(() => undefined)
                    .finally(() => currentClient.close());
            } else {
                currentClient?.close();
            }
        };
    }, [session, sessionId, botId, requests]);
    const request = {
        additionalDirectoryIds: (session.result.action === "preview"
            ? session.entry.additionalDirectories
            : session.result.ready.additionalDirectories
        ).map((directory) => directory.directoryId),
    };
    const send = async () => {
        if (
            connection.kind !== "ready" ||
            session.result.action === "preview" ||
            draft.trim() === "" ||
            operation.kind === "sending" ||
            operation.kind === "configuring"
        ) {
            return;
        }
        const commandId = crypto.randomUUID();
        command.current = commandId;
        const prompt = draft.trim();
        followLatest.current = true;
        setDraft("");
        setMessages((current) => [
            ...current,
            { id: commandId, role: "user", text: prompt },
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
                    images: [],
                    resources: [],
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
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                }}
                className="mx-auto w-full max-w-3xl space-y-3 p-4 sm:p-6"
            >
                <div className="flex flex-wrap gap-2">
                    {options
                        .filter(
                            (option) =>
                                ["model", "thought_level", "model_config"].includes(option.category) &&
                                option.type !== "boolean",
                        )
                        .map((option) => (
                            <div className="min-w-40 flex-1" key={option.id}>
                                <Select
                                    label={option.category === "model" ? "Model" : "Variant"}
                                    value={option.currentValue}
                                    options={option.values.map((value) => ({ value: value.value, label: value.name }))}
                                    disabled={busy}
                                    onValueChange={(value) => void configure(option, value)}
                                />
                            </div>
                        ))}
                </div>
                {operation.kind === "failed" && (
                    <p role="alert" className="text-sm text-destructive">
                        {operation.message}
                    </p>
                )}
                {operation.kind === "configuring" && (
                    <p role="status" className="text-xs text-muted-foreground">
                        Applying agent settings…
                    </p>
                )}
                {session.result.action === "preview" ? (
                    <p className="text-sm text-muted-foreground">
                        This agent provides a history preview but does not support continuing this session.
                    </p>
                ) : (
                    <ComposerSurface>
                        <Textarea
                            aria-label="Message local session"
                            placeholder="Continue this conversation…"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            disabled={busy}
                        />
                        <Button
                            type="submit"
                            size="icon"
                            aria-label="Send to local session"
                            disabled={busy || draft.trim() === ""}
                        >
                            <Send className="size-4" />
                        </Button>
                    </ComposerSurface>
                )}
            </form>
        </section>
    );
}
