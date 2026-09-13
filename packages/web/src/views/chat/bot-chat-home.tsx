import {
    createMobiusConversationSession,
    MobiusBrowserAccessToken,
    type MobiusBrowserClient,
    type MobiusBrowserHistory,
    MobiusPageRequest,
} from "@moxt-ai/mobius-sdk/browser";
import { MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { ChatControls } from "./chat-controls.tsx";
import { LocalSessionPane } from "./local-session-pane.tsx";
import { LocalSessionSidebar, type OpenLocalSession } from "./local-session-sidebar.tsx";

type State =
    | { readonly kind: "loading" }
    | { readonly kind: "setup" }
    | {
          readonly kind: "ready";
          readonly bot: ManagedBot;
          readonly client: MobiusBrowserClient;
          readonly history: MobiusBrowserHistory;
      }
    | { readonly kind: "failed"; readonly message: string };
type Sending =
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | { readonly kind: "failed"; readonly message: string };

function updateHistory(current: State, client: MobiusBrowserClient, history: MobiusBrowserHistory): State {
    if (
        current.kind !== "ready" ||
        current.client !== client ||
        BigInt(history.lastCommittedSeq) < BigInt(current.history.lastCommittedSeq)
    ) {
        return current;
    }
    return { ...current, history };
}

function attemptStatus(kind: string): string {
    switch (kind) {
        case "none":
        case "dispatching":
            return "Waiting for your agent…";
        case "running":
            return "Agent is thinking…";
        case "waiting_input":
            return "Your agent needs input. Check your local agent.";
        case "succeeded":
            return "Agent finished without a text response.";
        case "cancelled":
            return "Response cancelled.";
        case "failed":
            return "The agent could not complete this message.";
        case "indeterminate":
            return "The agent's completion status is unknown. Check your local agent.";
        default:
            return "Agent status is unavailable.";
    }
}

export function BotChatHome({
    requests,
}: {
    readonly requests: Pick<
        BotChatApi,
        "listBots" | "access" | "workspace" | "selectAgent" | "nativeSessions" | "connectSession"
    >;
}) {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [revision, retry] = useState(0);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState<Sending>({ kind: "idle" });
    const lifetime = useRef<AbortController | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    const [conversation, setConversation] = useState<
        { readonly kind: "bot" } | { readonly kind: "local"; readonly session: OpenLocalSession }
    >({ kind: "bot" });
    const showBot = useCallback(() => setConversation({ kind: "bot" }), []);
    const reconnect = useCallback(() => retry((value) => value + 1), []);
    useEffect(() => {
        if (state.kind === "ready" && followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [state]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect explicitly restarts the SDK session.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setConversation({ kind: "bot" });
        let client: MobiusBrowserClient | null = null;
        let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
        setState((current) => (current.kind === "setup" ? current : { kind: "loading" }));
        setSending({ kind: "idle" });
        const open = async () => {
            const bot = (await requests.listBots(controller.signal))[0];
            if (bot === undefined) {
                throw new Error("Your Bot is unavailable.");
            }
            const access = await requests.access(bot.botId, controller.signal);
            let initial = true;
            const session = createMobiusConversationSession({
                endpoint: access.endpoint,
                streamConnectionTimeoutMilliseconds: 45000,
                accessTokenProvider: {
                    accessToken: async (signal) => {
                        const token = initial ? access : await requests.access(bot.botId, signal);
                        initial = false;
                        if (token.endpoint !== access.endpoint || token.conversationId !== access.conversationId) {
                            throw new Error("The conversation identity changed. Reconnect to continue.");
                        }
                        return new MobiusBrowserAccessToken(token.credential, token.expiresAt);
                    },
                },
            });
            client = session;
            const history = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
            controller.signal.throwIfAborted();
            setState({ kind: "ready", bot, client: session, history });
            const refresh = async () => {
                const updated = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
                if (!controller.signal.aborted) {
                    setState((current) => updateHistory(current, session, updated));
                }
            };
            const reconcile = async () => {
                try {
                    await refresh();
                    if (!controller.signal.aborted) {
                        reconciliationTimer = setTimeout(() => void reconcile(), 5000);
                    }
                } catch (cause) {
                    if (!controller.signal.aborted) {
                        controller.abort();
                        session.close();
                        setState({
                            kind: "failed",
                            message:
                                cause instanceof Error
                                    ? cause.message
                                    : "Chat could not refresh. Reconnect to continue.",
                        });
                    }
                }
            };
            reconciliationTimer = setTimeout(() => void reconcile(), 5000);
            let events = await session.readEvents(new MobiusPageRequest(10, ""), controller.signal);
            while (events.hasMore) {
                events = await session.readEvents(new MobiusPageRequest(10, events.cursor), controller.signal);
            }
            const subscription = await session.events.subscribe(
                events.cursor,
                {
                    receive: async () => {
                        await refresh();
                        return true;
                    },
                },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            await subscription.completed;
            controller.signal.throwIfAborted();
            throw new Error("Chat updates disconnected. Reconnect to continue.");
        };
        void open().catch((cause: unknown) => {
            client?.close();
            if (!controller.signal.aborted) {
                if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                    setState({ kind: "setup" });
                    reconciliationTimer = setTimeout(() => retry((value) => value + 1), 5000);
                    return;
                }
                controller.abort();
                clearTimeout(reconciliationTimer);
                setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Chat is unavailable." });
            }
        });
        return () => {
            clearTimeout(reconciliationTimer);
            controller.abort();
            client?.close();
            lifetime.current = null;
        };
    }, [requests, revision]);

    const send = async () => {
        const controller = lifetime.current;
        if (state.kind !== "ready" || controller === null || sending.kind === "sending" || draft.trim().length === 0) {
            return;
        }
        setSending({ kind: "sending" });
        followLatest.current = true;
        try {
            const message = await state.client.messages.create(
                {
                    content: draft.trim(),
                    idempotencyKey: crypto.randomUUID(),
                    artifactIds: [],
                    images: [],
                    resources: [],
                },
                controller.signal,
            );
            await state.client.messages.run(message.messageId, controller.signal);
            const history = await state.client.history.read(new MobiusPageRequest(100, ""), controller.signal);
            if (!controller.signal.aborted) {
                setState((current) => updateHistory(current, state.client, history));
                setDraft("");
                setSending({ kind: "idle" });
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setSending({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The message could not be sent.",
                });
            }
        }
    };

    return (
        <main aria-label="Chat" className="flex h-dvh min-h-0 flex-col bg-background text-foreground sm:flex-row">
            {state.kind === "ready" ? (
                <LocalSessionSidebar
                    activeEntryId={conversation.kind === "local" ? conversation.session.entry.entryId : ""}
                    botId={state.bot.botId}
                    requests={requests}
                    onOpen={(session) => setConversation({ kind: "local", session })}
                    onChat={showBot}
                />
            ) : (
                <aside
                    aria-label="Conversations"
                    className="hidden w-60 shrink-0 border-r border-border bg-muted/30 p-4 sm:flex sm:flex-col"
                >
                    <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium">
                        <MessageSquare className="size-4" aria-hidden="true" />
                        My Bot
                    </div>
                </aside>
            )}
            {conversation.kind === "local" && state.kind === "ready" ? (
                <LocalSessionPane
                    botId={state.bot.botId}
                    requests={requests}
                    key={
                        conversation.session.result.action === "preview"
                            ? conversation.session.result.targetSessionId
                            : conversation.session.result.ready.sessionId
                    }
                    session={conversation.session}
                    onBack={showBot}
                />
            ) : (
                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div
                        ref={messageList}
                        onScroll={(event) => {
                            const element = event.currentTarget;
                            followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        }}
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
                        role="log"
                        aria-label="Messages"
                    >
                        {state.kind === "loading" ? (
                            <div className="m-auto">
                                <Spinner label="Connecting to your agent" />
                            </div>
                        ) : state.kind === "setup" ? (
                            <section className="m-auto w-full max-w-lg animate-cloud-enter rounded-2xl border border-border bg-card p-8 shadow-sm motion-reduce:animate-none">
                                <MessageSquare className="mb-5 size-8 text-primary" aria-hidden="true" />
                                <h1 className="text-2xl font-semibold tracking-tight">Your Chat is ready to connect</h1>
                                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                    Your anonymous workspace is loaded. Paste this instruction into your local agent to
                                    connect it to this workspace.
                                </p>
                                <input
                                    aria-label="Agent setup instruction"
                                    readOnly
                                    value={`follow ${window.location.origin}/SKILL.md`}
                                    onFocus={(event) => event.currentTarget.select()}
                                    className="mt-5 w-full rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                                <p role="status" className="mt-4 text-sm text-muted-foreground">
                                    Waiting for agent setup. Chat will open automatically when this Bot is connected.
                                </p>
                                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                    If your agent returns a link for another saved workspace, open that link to use its
                                    identity here.
                                </p>
                            </section>
                        ) : state.kind === "failed" ? (
                            <div className="m-auto grid justify-items-center gap-4 text-center">
                                <p role="alert">{state.message}</p>
                                <Button onClick={() => retry((value) => value + 1)}>Reconnect</Button>
                                <Button asChild variant="ghost">
                                    <a href="/SKILL.md">Agent setup instructions</a>
                                </Button>
                            </div>
                        ) : state.history.turns.length === 0 ? (
                            <div className="m-auto text-center">
                                <h1 className="text-2xl font-semibold">{state.bot.displayName}</h1>
                                <p className="mt-2 text-sm text-muted-foreground">Send a message to your agent.</p>
                            </div>
                        ) : (
                            [...state.history.turns].reverse().map((turn) => (
                                <div
                                    key={turn.commandId}
                                    className="mx-auto grid min-w-0 w-full max-w-3xl gap-4 [overflow-wrap:anywhere]"
                                >
                                    <article
                                        className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent px-4 py-3"
                                        aria-label="Your message"
                                    >
                                        {turn.prompt}
                                    </article>
                                    {turn.response.length > 0 ? (
                                        <article className="whitespace-pre-wrap px-4 py-3" aria-label="Agent response">
                                            {turn.response}
                                        </article>
                                    ) : (
                                        <p role="status" className="px-4 text-sm text-muted-foreground">
                                            {attemptStatus(turn.attempt.kind)}
                                        </p>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    <form
                        className="mx-auto mb-6 w-full max-w-3xl px-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void send();
                        }}
                    >
                        {state.kind === "ready" && (
                            <div className="mb-3">
                                <ChatControls
                                    botId={state.bot.botId}
                                    client={state.client}
                                    requests={requests}
                                    onAgentChanged={reconnect}
                                />
                            </div>
                        )}
                        {sending.kind === "failed" && (
                            <p role="alert" className="mb-2 text-sm text-destructive">
                                {sending.message}
                            </p>
                        )}
                        <div className="flex items-end gap-3 rounded-2xl border border-border bg-card p-4">
                            <Textarea
                                aria-label="Message"
                                placeholder="Message your agent…"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                disabled={state.kind !== "ready" || sending.kind === "sending"}
                            />
                            <Button
                                type="submit"
                                size="icon"
                                aria-label="Send message"
                                disabled={
                                    state.kind !== "ready" || sending.kind === "sending" || draft.trim().length === 0
                                }
                            >
                                <Send className="size-4" aria-hidden="true" />
                            </Button>
                        </div>
                    </form>
                </section>
            )}
        </main>
    );
}
