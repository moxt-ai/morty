import {
    ArrowLeft,
    Check,
    Copy,
    Link2,
    LoaderCircle,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    RefreshCw,
    Smartphone,
    Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useStore } from "zustand";

import { Button } from "@/components/ui/button";
import { useChatStore } from "@/view-models/chat-store";
import {
    createChannelAccessStore,
    formatAccessDate,
    linkedDeviceLabel,
} from "@/view-models/pairing/channel-access-store";

function ChannelAccessPanel({ channelId }: { readonly channelId: string }) {
    const [store] = useState(() => createChannelAccessStore(channelId));
    const viewModel = useStore(store);
    const controller = useRef(new AbortController());
    const { copyConfirmation, directory, link, revocation } = viewModel;

    useEffect(() => {
        const lifetime = new AbortController();
        controller.current = lifetime;
        void viewModel.loadDevices(lifetime.signal);
        return () => lifetime.abort();
    }, [viewModel.loadDevices]);

    return (
        <section aria-labelledby="channel-access-heading">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-2xl">
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                        Channel capability
                    </p>
                    <h2
                        className="mt-2 text-[28px] leading-9 font-semibold tracking-[-0.035em]"
                        id="channel-access-heading"
                    >
                        Share this channel
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Create a link that works once for 10 minutes. The new browser gets its own revocable credential;
                        your owner credential is never put in the link.
                    </p>
                </div>
                {directory.kind === "owner" && (
                    <Button
                        aria-busy={link.kind === "creating"}
                        className="min-h-11 shrink-0 sm:self-end"
                        disabled={link.kind === "creating"}
                        onClick={() => void viewModel.createLink(controller.current.signal)}
                    >
                        {link.kind === "creating" ? (
                            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                        ) : (
                            <Link2 aria-hidden="true" className="size-4" />
                        )}
                        Create one-time access link
                    </Button>
                )}
            </div>

            {directory.kind === "linked-device" && (
                <div className="mt-5 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm leading-6 text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                    This browser has linked-device access. It can use the channel, but only the original browser can
                    create links or revoke devices.
                </div>
            )}

            {directory.kind === "failed" && (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm leading-6 text-[#9b2c32]">{directory.message}</p>
                    <Button
                        className="min-h-11 shrink-0"
                        onClick={() => void viewModel.loadDevices(controller.current.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            )}

            {directory.kind === "loading" && (
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="mt-5 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                    Loading device access…
                </div>
            )}

            {link.kind === "ready" && (
                <div className="mt-5 rounded-xl border-[0.5px] border-[#9bd8b7] bg-[#f4fcf7] p-4 sm:p-5">
                    <label className="text-xs font-semibold text-foreground" htmlFor="one-time-access-link">
                        One-time access link
                    </label>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input
                            aria-describedby="one-time-access-link-help"
                            className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            id="one-time-access-link"
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            type="text"
                            value={link.url}
                        />
                        <Button
                            className="min-h-11 shrink-0"
                            onClick={() => void viewModel.copyLink()}
                            variant="outline"
                        >
                            {copyConfirmation === "Access link copied." ? (
                                <Check aria-hidden="true" className="size-4" />
                            ) : (
                                <Copy aria-hidden="true" className="size-4" />
                            )}
                            Copy link
                        </Button>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground" id="one-time-access-link-help">
                        Expires {formatAccessDate(link.expiresAt)} and becomes invalid immediately after one successful
                        use.
                    </p>
                    <p aria-live="polite" className="mt-1 text-xs leading-5 text-[#218854]">
                        {copyConfirmation}
                    </p>
                </div>
            )}

            {link.kind === "failed" && (
                <p aria-live="polite" className="mt-4 rounded-lg bg-[#fff0f0] px-4 py-3 text-sm text-[#9b2c32]">
                    {link.message}
                </p>
            )}

            {directory.kind === "owner" && (
                <div className="mt-6">
                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <h3 className="text-base font-semibold tracking-[-0.015em]">Linked devices</h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                Revoking a device does not affect this browser or other linked devices.
                            </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                            {directory.devices.length.toString()}
                        </span>
                    </div>

                    {directory.devices.length === 0 ? (
                        <p className="mt-4 rounded-xl border border-dashed border-black/15 bg-white/60 px-5 py-6 text-sm text-muted-foreground">
                            No other devices currently have access.
                        </p>
                    ) : (
                        <ul aria-label="Linked devices" className="mt-4 grid gap-3">
                            {directory.devices.map((device) => {
                                const isRevoking =
                                    revocation.kind === "revoking" && revocation.credentialId === device.credentialId;
                                return (
                                    <li
                                        className="flex flex-col gap-4 rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)] sm:flex-row sm:items-center"
                                        key={device.credentialId}
                                    >
                                        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                                            <Smartphone aria-hidden="true" className="size-[18px]" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <strong className="block text-sm font-semibold">
                                                {linkedDeviceLabel(device)}
                                            </strong>
                                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                                                Added {formatAccessDate(device.createdAt)} · Last used{" "}
                                                {formatAccessDate(device.lastUsedAt)}
                                            </span>
                                        </span>
                                        <Button
                                            aria-busy={isRevoking}
                                            aria-label={`Revoke linked device ${device.credentialId.slice(-6)}`}
                                            className="min-h-11 shrink-0 text-[#a1282e] hover:text-[#821f24]"
                                            disabled={revocation.kind === "revoking"}
                                            onClick={() =>
                                                void viewModel.revokeDevice(
                                                    device.credentialId,
                                                    controller.current.signal,
                                                )
                                            }
                                            variant="outline"
                                        >
                                            {isRevoking ? (
                                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                            ) : (
                                                <Trash2 aria-hidden="true" className="size-4" />
                                            )}
                                            Revoke
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}

            {revocation.kind === "failed" && (
                <p aria-live="polite" className="mt-4 rounded-lg bg-[#fff0f0] px-4 py-3 text-sm text-[#9b2c32]">
                    {revocation.message}
                </p>
            )}
        </section>
    );
}

export function ChannelAccessPage({
    channelId,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly channelId: string;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);

    return (
        <>
            <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
                <Button
                    aria-controls="conversation-sidebar"
                    aria-expanded={sidebarOpen}
                    aria-label="Open conversation sidebar"
                    className="mr-[7px] size-11 lg:hidden"
                    id="conversation-sidebar-trigger"
                    onClick={() => setSidebarOpen(true)}
                    size="icon"
                    variant="ghost"
                >
                    <Menu aria-hidden="true" className="size-[18px]" />
                </Button>
                <Button
                    aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    className="mr-2 hidden lg:inline-flex"
                    onClick={onToggleDesktopSidebar}
                    size="icon"
                    title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    variant="ghost"
                >
                    {desktopSidebarCollapsed ? (
                        <PanelLeftOpen aria-hidden="true" className="size-4" />
                    ) : (
                        <PanelLeftClose aria-hidden="true" className="size-4" />
                    )}
                </Button>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                    <Smartphone aria-hidden="true" className="size-4" />
                </span>
                <h1 className="ml-2 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">
                    Access from other devices
                </h1>
                <Link
                    aria-label="Back to chat"
                    className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-11 sm:w-auto sm:gap-1.5 sm:px-3"
                    relative="path"
                    to=".."
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    <span className="hidden sm:inline">Back to chat</span>
                </Link>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 sm:py-10">
                    <ChannelAccessPanel channelId={channelId} key={channelId} />
                </div>
            </div>
        </>
    );
}
