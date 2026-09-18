import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router";
import { useStore } from "zustand";
import { BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { createBotConversationsStore } from "@/view-models/bots/conversations-store";

export function BotConversationsPage() {
    const { api, bot, signal } = useOutletContext<BotDetailContext>();
    const [store] = useState(() => createBotConversationsStore(api, bot.botId));
    const viewModel = useStore(store);
    useEffect(() => {
        void viewModel.load(signal);
    }, [signal, viewModel.load]);
    return (
        <div className="mx-auto max-w-3xl p-5 sm:p-8">
            <h2 className="text-xl font-semibold">Conversations</h2>
            <p className="mt-1 text-sm text-muted-foreground">Generic Mobius Sessions started for this Chat Bot.</p>
            {viewModel.state.kind === "loading" && (
                <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> Loading Sessions…
                </p>
            )}
            {viewModel.state.kind === "failed" && <BotInlineError>{viewModel.state.message}</BotInlineError>}
            {viewModel.state.kind === "ready" && viewModel.state.sessions.length === 0 && (
                <p className="mt-6 rounded-2xl border border-dashed border-black/15 p-6 text-sm text-muted-foreground">
                    No conversations yet.
                </p>
            )}
            {viewModel.state.kind === "ready" && (
                <ul className="mt-5 grid gap-2">
                    {viewModel.state.sessions.map((session) => (
                        <li className="rounded-xl border border-black/10 bg-white p-4" key={session.id}>
                            <p className="text-sm font-semibold">{session.title || "Untitled Session"}</p>
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">{session.id}</p>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function BotConversationPage() {
    const conversationId = useParams<"conversationId">().conversationId ?? "";
    return (
        <div className="mx-auto max-w-3xl p-5 sm:p-8">
            <section className="rounded-2xl border border-black/10 bg-white p-6">
                <h2 className="text-xl font-semibold">Session</h2>
                <p className="mt-3 text-sm text-muted-foreground">This Bot conversation is a generic Mobius Session.</p>
                <p className="mt-3 break-all font-mono text-xs">{conversationId}</p>
            </section>
        </div>
    );
}
