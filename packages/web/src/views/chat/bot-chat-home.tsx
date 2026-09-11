import { MessageSquare, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { ManagedBot } from "../../services/management/management-api.ts";

export interface BotChatRequests {
    readonly listBots: (signal: AbortSignal) => Promise<readonly ManagedBot[]>;
}

type State =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bot: ManagedBot }
    | { readonly kind: "failed"; readonly message: string };

export function BotChatHome({ requests }: { readonly requests: BotChatRequests }) {
    const [state, setState] = useState<State>({ kind: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        void requests.listBots(controller.signal).then(
            (bots) => {
                if (controller.signal.aborted) {
                    return;
                }
                const bot = bots[0];
                setState(
                    bot === undefined
                        ? { kind: "failed", message: "Your Bot is unavailable. Please reload to retry." }
                        : { kind: "ready", bot },
                );
            },
            (cause: unknown) => {
                if (!controller.signal.aborted) {
                    setState({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Chat is unavailable.",
                    });
                }
            },
        );
        return () => controller.abort();
    }, [requests]);
    return (
        <main aria-label="Chat" className="flex h-dvh min-h-0 bg-background text-foreground">
            <aside
                aria-label="Conversations"
                className="hidden w-60 shrink-0 border-r border-border bg-muted/30 p-4 sm:flex sm:flex-col"
            >
                <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium">
                    <MessageSquare className="size-4" aria-hidden="true" />
                    {state.kind === "ready" ? state.bot.displayName : "Chat"}
                </div>
                <p className="mt-6 px-3 text-xs text-muted-foreground">Your conversations will appear here.</p>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    {state.kind === "loading" ? (
                        <Spinner label="Opening your Bot" />
                    ) : state.kind === "failed" ? (
                        <p role="alert">{state.message}</p>
                    ) : (
                        <>
                            <MessageSquare className="size-8 text-primary" aria-hidden="true" />
                            <h1 className="text-2xl font-semibold">{state.bot.displayName}</h1>
                            <p role="status" className="max-w-md text-sm text-muted-foreground">
                                Connect your local agent to start chatting.
                            </p>
                            <Button asChild variant="ghost">
                                <a href="/SKILL.md">Agent setup instructions</a>
                            </Button>
                        </>
                    )}
                </div>
                <div className="mx-auto mb-6 w-full max-w-3xl px-4">
                    <div className="flex items-end gap-3 rounded-2xl border border-border bg-card p-4">
                        <Textarea
                            aria-label="Message"
                            placeholder="Message your agent…"
                            disabled
                            className="min-h-12 flex-1 resize-none bg-transparent text-sm outline-none disabled:opacity-50"
                        />
                        <Button
                            type="button"
                            aria-label="Send message"
                            disabled
                            className="rounded-lg bg-primary p-2 text-primary-foreground opacity-40"
                        >
                            <Send className="size-4" aria-hidden="true" />
                        </Button>
                    </div>
                </div>
            </section>
        </main>
    );
}
