import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import { useStore } from "zustand";
import { BOT_FIELD_CLASS, BOT_TEXTAREA_CLASS, BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { Button } from "@/components/ui/button";
import { createBotOverviewStore } from "@/view-models/bots/overview-store";

export function BotOverviewPage() {
    const { api, bot, signal } = useOutletContext<BotDetailContext>();
    const [store] = useState(() => createBotOverviewStore(api, bot));
    const viewModel = useStore(store);
    useEffect(() => {
        void viewModel.load(signal);
    }, [signal, viewModel.load]);
    return (
        <div className="mx-auto max-w-3xl p-5 sm:p-8">
            <section className="rounded-2xl border border-black/10 bg-white p-6">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Morty Bot</p>
                <h2 className="mt-2 text-xl font-semibold">Profile and instructions</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    This Bot identity and its configuration are owned by Morty. Runtime execution uses generic Mobius
                    Sessions and turns.
                </p>
                {viewModel.state.kind === "ready" && (
                    <div className="mt-5 grid gap-4">
                        <label className="grid gap-2 text-xs font-semibold" htmlFor="chat-bot-name">
                            Bot name
                            <input
                                className={BOT_FIELD_CLASS}
                                id="chat-bot-name"
                                maxLength={80}
                                onChange={(event) => viewModel.setDisplayName(event.currentTarget.value)}
                                value={viewModel.state.displayName}
                            />
                        </label>
                        <label className="grid gap-2 text-xs font-semibold" htmlFor="chat-bot-instructions">
                            Instructions
                            <textarea
                                className={BOT_TEXTAREA_CLASS}
                                id="chat-bot-instructions"
                                maxLength={100000}
                                onChange={(event) => viewModel.setInstructions(event.currentTarget.value)}
                                value={viewModel.state.instructions}
                            />
                        </label>
                        {viewModel.state.save.kind === "failed" && (
                            <BotInlineError>{viewModel.state.save.message}</BotInlineError>
                        )}
                        <Button
                            disabled={viewModel.state.save.kind === "saving"}
                            onClick={() => void viewModel.save(signal)}
                        >
                            {viewModel.state.save.kind === "saving" ? "Saving…" : "Save Bot"}
                        </Button>
                    </div>
                )}
            </section>
            <section className="mt-5 rounded-2xl border border-black/10 bg-white p-6">
                <h2 className="text-base font-semibold">Runtime connection</h2>
                {viewModel.state.kind === "loading" && (
                    <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" /> Loading configuration…
                    </p>
                )}
                {viewModel.state.kind === "failed" && <BotInlineError>{viewModel.state.message}</BotInlineError>}
                {viewModel.state.kind === "ready" && viewModel.state.workspace.runtimeId === null && (
                    <p className="mt-3 text-sm text-muted-foreground">
                        This Bot is not configured yet. Open the main Chat workspace to connect its Runtime.
                    </p>
                )}
                {viewModel.state.kind === "ready" && viewModel.state.workspace.runtimeId !== null && (
                    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                        <div>
                            <dt className="text-muted-foreground">Runtime</dt>
                            <dd className="font-mono text-xs">{viewModel.state.workspace.runtimeId}</dd>
                        </div>
                    </dl>
                )}
            </section>
        </div>
    );
}
