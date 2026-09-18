import { Bot, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useStore } from "zustand";
import { BOT_FIELD_CLASS, BotAvatar, BotInlineError, BotPageHeader } from "@/components/bots/bot-page-header";
import { Button } from "@/components/ui/button";
import { useApiTransport } from "@/services/api/api-transport-context";
import { botRoutePath } from "@/services/application/app-routes";
import { ChatBotApi } from "@/services/bots/bot-api";
import { createBotDirectoryStore } from "@/view-models/bots/directory-store";
import type { ChannelConnection } from "@/view-models/chat/channel";
import { useActiveIdentity } from "@/views/authentication/identity-context";

export function BotDirectoryPage({
    connection,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const identity = useActiveIdentity();
    const transport = useApiTransport();
    const navigate = useNavigate();
    const controller = useRef(new AbortController());
    const [store] = useState(() => {
        const api = new ChatBotApi({
            origin: window.location.origin,
            projectId: identity.projectId,
            getToken: identity.getToken,
            fetchRequest: transport.fetch,
            waitForChange: transport.waitForChange,
        });
        return createBotDirectoryStore(api, async (bot) => {
            await navigate(botRoutePath(connection.channelId, bot.botId));
        });
    });
    const viewModel = useStore(store);

    useEffect(() => {
        const lifetime = new AbortController();
        controller.current = lifetime;
        void viewModel.reload(lifetime.signal);
        return () => lifetime.abort();
    }, [viewModel.reload]);

    return (
        <>
            <BotPageHeader
                desktopSidebarCollapsed={desktopSidebarCollapsed}
                onToggleDesktopSidebar={onToggleDesktopSidebar}
                title="Bots"
            />
            <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
                <div className="mx-auto max-w-4xl">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <h2 className="text-xl font-semibold tracking-[-0.025em]">Chat Bots</h2>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Bot identities, instructions, Agent selection, conversations, and Slack bindings are
                                owned by Mobius Chat.
                            </p>
                        </div>
                        <Button onClick={viewModel.openCreation}>
                            <Plus aria-hidden="true" className="size-4" /> New Bot
                        </Button>
                    </div>

                    {viewModel.creation.kind === "editing" && (
                        <section
                            className="mt-6 rounded-2xl border border-black/10 bg-white p-5"
                            aria-label="Create Bot"
                        >
                            <label className="text-xs font-semibold" htmlFor="new-bot-name">
                                Bot name
                            </label>
                            <input
                                className={`${BOT_FIELD_CLASS} mt-2`}
                                id="new-bot-name"
                                maxLength={80}
                                onChange={(event) => viewModel.setDisplayName(event.currentTarget.value)}
                                value={viewModel.creation.displayName}
                            />
                            {viewModel.creation.error.length > 0 && (
                                <BotInlineError>{viewModel.creation.error}</BotInlineError>
                            )}
                            <div className="mt-4 flex gap-2">
                                <Button
                                    disabled={viewModel.creation.submitting}
                                    onClick={() => void viewModel.submitCreation(controller.current.signal)}
                                >
                                    {viewModel.creation.submitting && <LoaderCircle className="size-4 animate-spin" />}
                                    Create Bot
                                </Button>
                                <Button onClick={viewModel.closeCreation} variant="outline">
                                    Cancel
                                </Button>
                            </div>
                        </section>
                    )}

                    {viewModel.directory.kind === "loading" && (
                        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                            <LoaderCircle className="size-4 animate-spin" /> Loading Chat Bots…
                        </div>
                    )}
                    {viewModel.directory.kind === "failed" && (
                        <div className="mt-8 rounded-2xl border border-[#f2c4c4] bg-[#fff7f7] p-5">
                            <BotInlineError>{viewModel.directory.message}</BotInlineError>
                            <Button
                                className="mt-3"
                                onClick={() => void viewModel.reload(controller.current.signal)}
                                variant="outline"
                            >
                                <RefreshCw className="size-4" /> Retry
                            </Button>
                        </div>
                    )}
                    {viewModel.directory.kind === "ready" && viewModel.directory.bots.length === 0 && (
                        <div className="mt-8 rounded-2xl border border-dashed border-black/15 p-8 text-center text-sm text-muted-foreground">
                            <Bot className="mx-auto mb-3 size-6" /> Create a Bot to get started.
                        </div>
                    )}
                    {viewModel.directory.kind === "ready" && (
                        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                            {viewModel.directory.bots.map((bot) => (
                                <li key={bot.botId}>
                                    <Button
                                        className="flex w-full items-center gap-3 rounded-2xl border border-black/10 bg-white p-4 text-left hover:bg-black/[0.02]"
                                        onClick={() => void navigate(botRoutePath(connection.channelId, bot.botId))}
                                        variant="ghost"
                                    >
                                        <BotAvatar bot={bot} />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-semibold">
                                                {bot.displayName}
                                            </span>
                                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                                {bot.botId}
                                            </span>
                                        </span>
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
}
