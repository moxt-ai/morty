import {
    createMobiusConversationSession,
    MobiusBrowserAccessToken,
    type MobiusBrowserClient,
    type MobiusBrowserHistory,
    MobiusPageRequest,
} from "@moxt-ai/mobius-sdk/browser";
import { MessageSquare, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";

type State =
    | { readonly kind: "loading" }
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

export function BotChatHome({ requests }: { readonly requests: Pick<BotChatApi, "listBots" | "access"> }) {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [revision, retry] = useState(0);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState<Sending>({ kind: "idle" });
    const lifetime = useRef<AbortController | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect explicitly restarts the SDK session.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        let client: MobiusBrowserClient | null = null;
        setState({ kind: "loading" });
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
            let events = await session.readEvents(new MobiusPageRequest(10, ""), controller.signal);
            while (events.hasMore) {
                events = await session.readEvents(new MobiusPageRequest(10, events.cursor), controller.signal);
            }
            const history = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
            controller.signal.throwIfAborted();
            const subscription = await session.events.subscribe(
                events.cursor,
                {
                    receive: async () => {
                        const updated = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
                        if (!controller.signal.aborted) {
                            setState({ kind: "ready", bot, client: session, history: updated });
                        }
                        return true;
                    },
                },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            setState((current) =>
                current.kind === "ready" && current.client === session
                    ? current
                    : { kind: "ready", bot, client: session, history },
            );
            await subscription.completed;
        };
        void open().catch((cause: unknown) => {
            client?.close();
            if (!controller.signal.aborted) {
                setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Chat is unavailable." });
            }
        });
        return () => {
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
                setState({ ...state, history });
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
        <main aria-label="Chat" className="flex h-dvh min-h-0 bg-background text-foreground">
            <aside
                aria-label="Conversations"
                className="hidden w-60 shrink-0 border-r border-border bg-muted/30 p-4 sm:flex sm:flex-col"
            >
                <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium">
                    <MessageSquare className="size-4" aria-hidden="true" />
                    My Bot
                </div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                <div
                    className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
                    role="log"
                    aria-label="Messages"
                >
                    {state.kind === "loading" ? (
                        <div className="m-auto">
                            <Spinner label="Connecting to your agent" />
                        </div>
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
                        state.history.turns.map((turn) => (
                            <div key={turn.messageId} className="mx-auto grid w-full max-w-3xl gap-4">
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
                                        Agent is thinking…
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
                            disabled={state.kind !== "ready" || sending.kind === "sending" || draft.trim().length === 0}
                        >
                            <Send className="size-4" aria-hidden="true" />
                        </Button>
                    </div>
                </form>
            </section>
        </main>
    );
}
