import { ArrowRight, Bot, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useStore } from "zustand";
import {
    BOT_FIELD_CLASS,
    BOT_TEXTAREA_CLASS,
    BotAvatar,
    BotInlineError,
    BotPageHeader,
    BotStatusBadge,
} from "@/components/bots/bot-page-header";
import { Button } from "@/components/ui/button";
import { botRoutePath } from "@/services/application/app-routes";
import {
    type BotCreationState,
    type BotDirectoryState,
    createBotDirectoryStore,
    formatBotUpdatedAt,
} from "@/view-models/bots/directory-store";
import type { ChannelConnection } from "@/view-models/chat/channel";

function BotDirectoryContent({
    channelId,
    creation,
    directory,
    onCloseCreation,
    onOpenCreation,
    onReload,
    onSetAvatarRef,
    onSetDescription,
    onSetDisplayName,
    onSubmitCreation,
}: {
    readonly channelId: string;
    readonly creation: BotCreationState;
    readonly directory: Extract<BotDirectoryState, { readonly kind: "ready" }>;
    readonly onCloseCreation: () => void;
    readonly onOpenCreation: () => void;
    readonly onReload: () => Promise<void>;
    readonly onSetAvatarRef: (value: string) => void;
    readonly onSetDescription: (value: string) => void;
    readonly onSetDisplayName: (value: string) => void;
    readonly onSubmitCreation: () => Promise<void>;
}) {
    const errorSummaryRef = useRef<HTMLDivElement>(null);
    const createOpen = creation.kind === "editing";
    const creating = creation.kind === "editing" && creation.submitting;
    const formError = creation.kind === "editing" ? creation.error : "";
    useEffect(() => {
        if (formError.length > 0) {
            queueMicrotask(() => errorSummaryRef.current?.focus());
        }
    }, [formError]);

    return (
        <div className="mx-auto w-full max-w-[1040px] px-5 py-8 sm:px-8 sm:py-10">
            <section aria-labelledby="bot-directory-heading">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="max-w-2xl">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Stable identities
                        </p>
                        <h2
                            className="mt-2 text-[28px] leading-9 font-semibold tracking-[-0.035em]"
                            id="bot-directory-heading"
                        >
                            Your Bots
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            Give each Bot its own identity and behavior, then approve exactly which local Agent and
                            workspace may execute it.
                        </p>
                    </div>
                    {!createOpen && (
                        <Button className="min-h-11 shrink-0" onClick={onOpenCreation}>
                            <Plus aria-hidden="true" className="size-4" /> Create Bot
                        </Button>
                    )}
                </div>

                {createOpen && (
                    <form
                        aria-labelledby="create-bot-heading"
                        className="mt-6 rounded-2xl border-[0.5px] border-black/10 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.04)] sm:p-6"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void onSubmitCreation();
                        }}
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 className="text-base font-semibold" id="create-bot-heading">
                                    Create a Bot
                                </h3>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    The Bot starts as a draft until you activate it for a local Agent and workspace.
                                </p>
                            </div>
                            <Button
                                aria-label="Close Bot form"
                                className="size-11 sm:size-9"
                                disabled={creating}
                                onClick={onCloseCreation}
                                size="icon"
                                type="button"
                                variant="ghost"
                            >
                                <X aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                        {formError.length > 0 && (
                            <div
                                className="mt-4 rounded-lg border border-[#f2c4c4] bg-[#fff7f7] px-3 py-2 text-sm text-[#9b2c32] outline-none"
                                ref={errorSummaryRef}
                                role="alert"
                                tabIndex={-1}
                            >
                                {formError}
                            </div>
                        )}
                        <div className="mt-5 grid gap-4 sm:grid-cols-2">
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-name">
                                Bot name
                                <input
                                    aria-describedby="bot-name-help"
                                    aria-label="Bot name"
                                    autoComplete="off"
                                    className={BOT_FIELD_CLASS}
                                    disabled={creating}
                                    id="bot-name"
                                    maxLength={80}
                                    onChange={(event) => onSetDisplayName(event.target.value)}
                                    placeholder="Research assistant"
                                    value={creation.kind === "editing" ? creation.displayName : ""}
                                />
                                <span className="font-normal text-muted-foreground" id="bot-name-help">
                                    A stable, user-facing identity. You can revise it later.
                                </span>
                            </label>
                            <label className="grid gap-1.5 text-xs font-semibold" htmlFor="bot-avatar-ref">
                                Avatar reference <span className="font-normal text-muted-foreground">Optional</span>
                                <input
                                    autoComplete="off"
                                    className={BOT_FIELD_CLASS}
                                    disabled={creating}
                                    id="bot-avatar-ref"
                                    maxLength={4096}
                                    onChange={(event) => onSetAvatarRef(event.target.value)}
                                    placeholder="https://… or an asset reference"
                                    value={creation.kind === "editing" ? creation.avatarRef : ""}
                                />
                            </label>
                        </div>
                        <label className="mt-4 grid gap-1.5 text-xs font-semibold" htmlFor="bot-description">
                            Description
                            <textarea
                                className={BOT_TEXTAREA_CLASS}
                                disabled={creating}
                                id="bot-description"
                                maxLength={2000}
                                onChange={(event) => onSetDescription(event.target.value)}
                                placeholder="What this Bot is for"
                                value={creation.kind === "editing" ? creation.description : ""}
                            />
                        </label>
                        <div className="mt-5 flex flex-wrap items-center gap-2">
                            <Button aria-busy={creating} className="min-h-11" disabled={creating} type="submit">
                                {creating ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <Bot aria-hidden="true" className="size-4" />
                                )}
                                Create Bot
                            </Button>
                            <Button
                                className="min-h-11"
                                disabled={creating}
                                onClick={onCloseCreation}
                                type="button"
                                variant="ghost"
                            >
                                Cancel
                            </Button>
                        </div>
                    </form>
                )}
            </section>

            <section aria-labelledby="existing-bots-heading" className="mt-10">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold" id="existing-bots-heading">
                        Bots
                    </h2>
                    <Button
                        aria-label="Refresh Bots"
                        className="size-11 sm:size-9"
                        onClick={() => void onReload()}
                        size="icon"
                        variant="ghost"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                </div>
                {directory.bots.length === 0 ? (
                    <div className="mt-4 rounded-2xl border border-dashed border-black/15 bg-white/60 px-6 py-10 text-center">
                        <span className="mx-auto inline-flex size-11 items-center justify-center rounded-xl bg-[#eefaf3] text-[#218854]">
                            <Bot aria-hidden="true" className="size-5" />
                        </span>
                        <p className="mt-3 text-sm font-semibold">No Bots yet</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Create a draft identity, then bind it to a compatible local Agent.
                        </p>
                    </div>
                ) : (
                    <ul aria-label="Bots" className="mt-4 grid gap-3 md:grid-cols-2">
                        {directory.bots.map((bot) => (
                            <li key={bot.botId}>
                                <Link
                                    className="group flex min-h-32 items-start gap-3 rounded-2xl border-[0.5px] border-black/10 bg-white p-4 text-foreground no-underline shadow-[0_1px_4px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow,transform] duration-150 motion-reduce:transition-none motion-safe:hover:-translate-y-px hover:border-black/16 hover:shadow-[0_6px_18px_rgba(0,0,0,0.06)] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                                    to={botRoutePath(channelId, bot.botId)}
                                >
                                    <BotAvatar bot={bot} />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-2">
                                            <strong className="truncate text-sm font-semibold">
                                                {bot.displayName}
                                            </strong>
                                            <BotStatusBadge bot={bot} />
                                        </span>
                                        <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                                            {bot.description.length > 0 ? bot.description : "No description yet."}
                                        </span>
                                        <span className="mt-3 block text-[11px] text-muted-foreground">
                                            Updated {formatBotUpdatedAt(bot.updatedAt)}
                                        </span>
                                    </span>
                                    <ArrowRight
                                        aria-hidden="true"
                                        className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                                    />
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

export function BotDirectoryPage({
    connection,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const navigate = useNavigate();
    const [store] = useState(() =>
        createBotDirectoryStore(connection, async (bot) => {
            await navigate(botRoutePath(connection.channelId, bot.botId));
        }),
    );
    const viewModel = useStore(store);
    const controller = useRef(new AbortController());
    const { directory } = viewModel;

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
            <div className="min-h-0 flex-1 overflow-y-auto">
                {directory.kind === "loading" && (
                    <div
                        aria-busy="true"
                        aria-live="polite"
                        className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"
                    >
                        <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> Loading Bots…
                    </div>
                )}
                {directory.kind === "linked-device" && (
                    <div className="mx-auto mt-10 w-[min(640px,calc(100%-40px))] rounded-2xl border-[0.5px] border-black/10 bg-white p-6 text-center">
                        <h2 className="text-base font-semibold">Owner access required</h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            Linked devices can use Agent conversations, but Bot identities, behavior, and external
                            connections can only be managed from the original owner browser.
                        </p>
                    </div>
                )}
                {directory.kind === "failed" && (
                    <div className="mx-auto mt-10 w-[min(640px,calc(100%-40px))] rounded-2xl border border-[#f2c4c4] bg-[#fff7f7] p-6 text-center">
                        <h2 className="text-base font-semibold text-[#9b2c32]">Bots unavailable</h2>
                        <BotInlineError>{directory.message}</BotInlineError>
                        <Button
                            className="mt-5 min-h-11"
                            onClick={() => void viewModel.reload(controller.current.signal)}
                            variant="outline"
                        >
                            <RefreshCw aria-hidden="true" className="size-4" /> Retry
                        </Button>
                    </div>
                )}
                {directory.kind === "ready" && (
                    <BotDirectoryContent
                        channelId={connection.channelId}
                        creation={viewModel.creation}
                        directory={directory}
                        onCloseCreation={viewModel.closeCreation}
                        onOpenCreation={viewModel.openCreation}
                        onReload={() => viewModel.reload(controller.current.signal)}
                        onSetAvatarRef={viewModel.setAvatarRef}
                        onSetDescription={viewModel.setDescription}
                        onSetDisplayName={viewModel.setDisplayName}
                        onSubmitCreation={() => viewModel.submitCreation(controller.current.signal)}
                    />
                )}
            </div>
        </>
    );
}
