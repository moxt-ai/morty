import { Clock3, ShieldCheck } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { topNoticeActionClassName, topNoticeCardClassName } from "../../components/chat/top-notice.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { overlayMenuSeparatorClassName } from "../../components/ui/overlay-surface.ts";
import { cn } from "../../lib/utils.ts";
import type { AccessExpiryStore } from "../../view-models/chat/access-expiry-store.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";

/**
 * Tells this browser about its access, once each way: when it joined, until when it can use the computer and where
 * every device can be seen and disconnected; and, near the end, how to keep using Morty here.
 */
export function AccessNotice({
    computerName,
    onOpenDevices,
    store,
}: {
    readonly computerName: string;
    /** Opens the devices with access; null when this page cannot list them. */
    readonly onOpenDevices: (() => void) | null;
    readonly store: StoreApi<AccessExpiryStore>;
}) {
    const { state, onAttach, dismiss } = useStore(store);
    const shown = state.kind === "known" && state.expiresAt !== null ? state : null;
    return (
        <div className="contents" ref={onAttach}>
            {shown?.notice === "joined" && shown.expiresAt !== null && (
                <section aria-label="This browser's access" className={topNoticeCardClassName} role="status">
                    <p className="flex items-center gap-2 font-medium">
                        <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        This browser can use {computerName || "your computer"} until {formatMoment(shown.expiresAt)}.
                    </p>
                    <p className="mt-2 text-muted-foreground">
                        Only devices you add can use your computer. See them, or disconnect any, in Devices.
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                        {onOpenDevices !== null && (
                            <Button
                                className={topNoticeActionClassName}
                                onClick={() => {
                                    dismiss();
                                    onOpenDevices();
                                }}
                                size="sm"
                                variant="ghost"
                            >
                                Devices
                            </Button>
                        )}
                        <Button className={topNoticeActionClassName} onClick={dismiss} size="sm">
                            Got it
                        </Button>
                    </div>
                </section>
            )}
            {shown?.notice === "ending" && shown.expiresAt !== null && (
                <section aria-label="Access ending soon" className={topNoticeCardClassName} role="status">
                    <p className="flex items-center gap-2 font-medium">
                        <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        Access in this browser ends {formatMoment(shown.expiresAt)}
                    </p>
                    <p className="mt-2 text-muted-foreground">
                        To keep using Morty here, open a new link from your computer or another device. Your local agent
                        and tasks keep running.
                    </p>
                    <div className="mt-3 flex justify-end">
                        <Button className={topNoticeActionClassName} onClick={dismiss} size="sm">
                            Got it
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}

/**
 * This browser's access term as a read-only line: heading the desktop account menu, or a row of the phone's connection
 * actions. Nothing when the access has no term.
 */
export function AccessTerm({
    layout,
    store,
}: {
    readonly layout: "menu" | "card";
    readonly store: StoreApi<AccessExpiryStore>;
}) {
    const state = useStore(store, (model) => model.state);
    if (state.kind !== "known" || state.expiresAt === null) {
        return null;
    }
    const term = (
        <div className="min-w-0">
            <p
                className={
                    layout === "card" ? "text-[15px] font-medium text-foreground" : "font-medium text-foreground"
                }
            >
                Access in this browser
            </p>
            <p className="text-xs text-muted-foreground">Until {formatMoment(state.expiresAt)}</p>
        </div>
    );
    if (layout === "card") {
        return (
            <div className="flex min-h-12 items-center gap-3 px-4 py-2">
                <Clock3 aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                {term}
            </div>
        );
    }
    return (
        <>
            <DropdownMenu.Label className="flex items-center gap-2 px-3 py-1.5">
                <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                {term}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
        </>
    );
}
