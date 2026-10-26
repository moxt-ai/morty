/** Corner radius for anchored popovers, dialogs, menus, and similar floating panels (24px). */
export const overlaySurfaceRadiusClassName = "rounded-overlay";

/** Gap between an anchored floating panel and its trigger. */
export const overlayTriggerOffsetPx = 6;

/** Desktop width for the execution details dialog (mobile is a full-width bottom sheet). */
export const executionDetailsDialogWidthPx = 480;

/** Must stay in sync with {@link executionDetailsDialogWidthPx}. */
export const executionDetailsDialogDesktopWidthClassName = "sm:w-[480px]";

/** Solid panel surface shared by configuration popovers and nested pickers. Matches input fill. */
export const overlaySurfacePanelClassName =
    "border-[1px] border-white bg-background shadow-[0_16px_42px_rgba(0,0,0,0.14)]";

/** Hairline divider inside floating menus and menu-like popovers. */
export const overlayMenuSeparatorClassName = "h-[0.5px] bg-black/[0.06]";

/** Radix dismissable layers honor this at runtime; some primitive typings omit it. */
export type OverlayContentOpenAutoFocus = {
    readonly onOpenAutoFocus?: (event: Event) => void;
};

export function preventOverlayOpenAutoFocus(event: Event): void {
    event.preventDefault();
}
