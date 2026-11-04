import { Clock3, ShieldCheck } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "../../components/ui/cloud-button.tsx";
import { overlayMenuSeparatorClassName } from "../../components/ui/overlay-surface.ts";
import { cn } from "../../lib/utils.ts";
import type { AccessExpiryStore } from "../../view-models/chat/access-expiry-store.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";

/** Matches the conversation pane card: light fill, white border, module shadow. */
const accessNoticeCardClassName =
    "pointer-events-auto relative mt-0 mb-0 w-full min-w-0 max-w-full shrink-0 rounded-[20px] border border-white bg-card/90 px-3 py-3 text-12 text-foreground shadow-module [overflow-wrap:anywhere]";
/** Icon lines up with the vertical center of the title's first line (text-13), not a multi-line block. */
const accessNoticeTitleRowClassName = "flex items-start gap-2";
const accessNoticeTitleIconClassName = "mt-[3px] size-3.5 shrink-0";
const accessNoticeIconSpacerClassName = "size-3.5 shrink-0";
const accessNoticeIndentedRowClassName = "flex items-start gap-2";
const accessNoticeTitleClassName = "text-13 font-semibold leading-5";
const accessNoticeDetailClassName = "text-12 leading-4 text-muted-foreground";
export const sidebarAccessNoticeActionClassName = "max-w-full whitespace-normal";
const accessNoticeActionsClassName = "flex flex-wrap items-center gap-1.5 pt-3 pb-1";

export function SidebarAccessNoticeCard({
    actions,
    body,
    detail,
    icon: Icon,
    label,
    title,
}: {
    readonly actions: ReactNode;
    readonly body?: ReactNode;
    readonly detail: string;
    readonly icon: typeof ShieldCheck;
    readonly label: string;
    readonly title: string;
}) {
    if (body === undefined) {
        return (
            <section aria-label={label} className={accessNoticeCardClassName} role="status">
                <div className={accessNoticeTitleRowClassName}>
                    <Icon aria-hidden="true" className={accessNoticeTitleIconClassName} />
                    <p className={cn(accessNoticeTitleClassName, "min-w-0 flex-1")}>{title}</p>
                </div>
                <div className={cn(accessNoticeIndentedRowClassName, "mt-1")}>
                    <div aria-hidden="true" className={accessNoticeIconSpacerClassName} />
                    <div className="min-w-0 flex-1">
                        <p className={accessNoticeDetailClassName}>{detail}</p>
                        <div className={accessNoticeActionsClassName}>{actions}</div>
                    </div>
                </div>
            </section>
        );
    }

    return (
        <section aria-label={label} className={accessNoticeCardClassName} role="status">
            <div className={accessNoticeTitleRowClassName}>
                <Icon aria-hidden="true" className={accessNoticeTitleIconClassName} />
                <p className={cn(accessNoticeTitleClassName, "min-w-0 flex-1")}>{title}</p>
            </div>
            <div className={cn(accessNoticeIndentedRowClassName, "mt-2")}>
                <div aria-hidden="true" className={accessNoticeIconSpacerClassName} />
                <div className="min-w-0 flex-1">{body}</div>
            </div>
            <div className={cn(accessNoticeIndentedRowClassName, "mt-1")}>
                <div aria-hidden="true" className={accessNoticeIconSpacerClassName} />
                <div className="min-w-0 flex-1">
                    <p className={accessNoticeDetailClassName}>{detail}</p>
                    <div className={accessNoticeActionsClassName}>{actions}</div>
                </div>
            </div>
        </section>
    );
}

function JoinedAccessNoticeCard({
    computerName,
    expiresAt,
    onDismiss,
    onOpenDevices,
}: {
    readonly computerName: string;
    readonly expiresAt: string;
    readonly onDismiss: () => void;
    readonly onOpenDevices: (() => void) | null;
}) {
    return (
        <SidebarAccessNoticeCard
            actions={
                <>
                    <Button className={sidebarAccessNoticeActionClassName} onClick={onDismiss} size="xs">
                        Got it
                    </Button>
                    {onOpenDevices !== null && (
                        <Button
                            className={sidebarAccessNoticeActionClassName}
                            onClick={onOpenDevices}
                            size="xs"
                            variant="outline"
                        >
                            Devices
                        </Button>
                    )}
                </>
            }
            detail="Only devices you add can use your computer. See them, or disconnect any, in Devices."
            icon={ShieldCheck}
            label="This browser's access"
            title={`This browser can use ${computerName || "your computer"} until ${formatMoment(expiresAt)}.`}
        />
    );
}

function EndingAccessNoticeCard({
    expiresAt,
    onDismiss,
}: {
    readonly expiresAt: string;
    readonly onDismiss: () => void;
}) {
    return (
        <SidebarAccessNoticeCard
            actions={
                <Button className={sidebarAccessNoticeActionClassName} onClick={onDismiss} size="xs">
                    Got it
                </Button>
            }
            detail="To keep using Morty here, open a new link from your computer or another device. Your local agent and tasks keep running."
            icon={Clock3}
            label="Access ending soon"
            title={`Access in this browser ends ${formatMoment(expiresAt)}`}
        />
    );
}

/**
 * Tells this browser about its access, once each way: when it joined, until when it can use the computer and where
 * every device can be seen and disconnected; and, near the end, how to keep using Morty here.
 * Render in the sidebar drawer immediately above the account and connection actions row.
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
    const { state, dismiss } = useStore(store);
    const shown = state.kind === "known" && state.expiresAt !== null ? state : null;
    if (shown?.notice === "joined" && shown.expiresAt !== null) {
        return (
            <JoinedAccessNoticeCard
                computerName={computerName}
                expiresAt={shown.expiresAt}
                onDismiss={dismiss}
                onOpenDevices={onOpenDevices}
            />
        );
    }
    if (shown?.notice === "ending" && shown.expiresAt !== null) {
        return <EndingAccessNoticeCard expiresAt={shown.expiresAt} onDismiss={dismiss} />;
    }
    return null;
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
    const titleClassName =
        layout === "card"
            ? "text-[15px] font-medium leading-5 text-foreground"
            : "font-medium leading-5 text-foreground";
    const term = (
        <div className="min-w-0">
            <p className={titleClassName}>Access in this browser</p>
            <p className="text-xs text-muted-foreground">Until {formatMoment(state.expiresAt)}</p>
        </div>
    );
    const termIconClassName = layout === "card" ? "size-5 text-copy-secondary" : "size-4 text-muted-foreground";
    const termIconRowClassName = "flex h-5 shrink-0 items-center";
    if (layout === "card") {
        return (
            <div className="flex min-h-12 items-start gap-3 px-4 py-2">
                <div className={termIconRowClassName}>
                    <Clock3 aria-hidden="true" className={termIconClassName} />
                </div>
                {term}
            </div>
        );
    }
    return (
        <>
            <DropdownMenu.Label className="flex items-start gap-2 px-3 py-1.5">
                <div className={termIconRowClassName}>
                    <Clock3 aria-hidden="true" className={termIconClassName} />
                </div>
                {term}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
        </>
    );
}
