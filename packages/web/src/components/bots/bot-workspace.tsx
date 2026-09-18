import { LoaderCircle, MessageSquare, Plug, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router";
import { useStore } from "zustand";
import { BotAvatar, BotInlineError, BotPageHeader, BotStatusBadge } from "@/components/bots/bot-page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    botConnectionsRoutePath,
    botConversationsRoutePath,
    botDirectoryRoutePath,
    botRoutePath,
} from "@/services/application/app-routes";
import { type ChatBot, ChatBotApi, type ChatBotDetail } from "@/services/bots/bot-api";
import { createBotWorkspaceStore } from "@/view-models/bots/workspace-store";
import type { ChannelConnection } from "@/view-models/chat/channel";
import { useActiveIdentity } from "@/views/authentication/identity-context";

export interface BotDetailContext {
    readonly api: ChatBotApi;
    readonly bot: ChatBotDetail;
    readonly configured: boolean;
    readonly connection: ChannelConnection;
    readonly signal: AbortSignal;
}

function BotTabs({ bot, channelId }: { readonly bot: ChatBot; readonly channelId: string }) {
    const linkClass = ({ isActive }: { readonly isActive: boolean }): string =>
        cn(
            "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted-foreground no-underline hover:bg-black/5 hover:text-foreground",
            isActive && "bg-black/[0.065] text-foreground",
        );
    return (
        <nav aria-label="Bot sections" className="flex gap-1 overflow-x-auto px-5 pb-3 sm:px-8">
            <NavLink className={linkClass} end to={botRoutePath(channelId, bot.botId)}>
                <SlidersHorizontal className="size-3.5" /> Overview
            </NavLink>
            <NavLink className={linkClass} to={botConversationsRoutePath(channelId, bot.botId)}>
                <MessageSquare className="size-3.5" /> Conversations
            </NavLink>
            <NavLink className={linkClass} to={botConnectionsRoutePath(channelId, bot.botId)}>
                <Plug className="size-3.5" /> Connections
            </NavLink>
        </nav>
    );
}

export function BotWorkspace({
    connection,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const identity = useActiveIdentity();
    const botId = useParams<"botId">().botId ?? "";
    const [api] = useState(
        () =>
            new ChatBotApi({
                origin: window.location.origin,
                projectId: identity.projectId,
                getToken: identity.getToken,
            }),
    );
    const [store] = useState(() => createBotWorkspaceStore(api, botId));
    const viewModel = useStore(store);
    const controller = useRef(new AbortController());

    useEffect(() => {
        const lifetime = new AbortController();
        controller.current = lifetime;
        void viewModel.load(lifetime.signal);
        return () => lifetime.abort();
    }, [viewModel.load]);

    if (viewModel.state.kind === "loading") {
        return (
            <>
                <BotPageHeader
                    backLabel="All Bots"
                    backTo={botDirectoryRoutePath(connection.channelId)}
                    desktopSidebarCollapsed={desktopSidebarCollapsed}
                    onToggleDesktopSidebar={onToggleDesktopSidebar}
                    title="Opening Bot"
                />
                <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-5 animate-spin" /> Loading Bot…
                </div>
            </>
        );
    }
    if (viewModel.state.kind === "failed") {
        return (
            <>
                <BotPageHeader
                    backLabel="All Bots"
                    backTo={botDirectoryRoutePath(connection.channelId)}
                    desktopSidebarCollapsed={desktopSidebarCollapsed}
                    onToggleDesktopSidebar={onToggleDesktopSidebar}
                    title="Bot unavailable"
                />
                <div className="mx-auto mt-10 w-[min(640px,calc(100%-40px))] rounded-2xl border border-[#f2c4c4] bg-[#fff7f7] p-6">
                    <BotInlineError>{viewModel.state.message}</BotInlineError>
                    <Button
                        className="mt-4"
                        onClick={() => void viewModel.load(controller.current.signal)}
                        variant="outline"
                    >
                        <RefreshCw className="size-4" /> Retry
                    </Button>
                </div>
            </>
        );
    }
    const { bot, configured } = viewModel.state;
    const context: BotDetailContext = { api, bot, configured, connection, signal: controller.current.signal };
    return (
        <>
            <BotPageHeader
                backLabel="All Bots"
                backTo={botDirectoryRoutePath(connection.channelId)}
                desktopSidebarCollapsed={desktopSidebarCollapsed}
                leading={<BotAvatar bot={bot} className="size-8" />}
                onToggleDesktopSidebar={onToggleDesktopSidebar}
                title={bot.displayName}
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-black/6 bg-white/55 pt-3">
                    <div className="flex items-center justify-between px-5 pb-2 sm:px-8">
                        <div className="flex items-center gap-2">
                            <BotStatusBadge configured={configured} />
                            <span className="font-mono text-[10px] text-muted-foreground">{bot.botId}</span>
                        </div>
                        <Button
                            disabled={viewModel.refreshing}
                            onClick={() => void viewModel.refresh(controller.current.signal)}
                            variant="ghost"
                        >
                            <RefreshCw className={cn("size-3.5", viewModel.refreshing && "animate-spin")} /> Refresh
                        </Button>
                    </div>
                    <BotTabs bot={bot} channelId={connection.channelId} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <Outlet context={context} />
                </div>
            </div>
        </>
    );
}
