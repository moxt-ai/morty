/**
 * Centered overlay and anchored-panel width ladder for Morty Web.
 *
 * Dialog rungs (desktop): standard 520 → medium 680 → large 840 → wide 1024; the agent configuration popover is 360.
 *
 * Not in this ladder:
 * - Mobile bottom sheets (full viewport width)
 * - Fullscreen viewers (Mermaid, images) and file preview drawer
 * - Setup page cards (`setup-card-shell`: 460 / 960) — page layout, not Dialog
 */

/** Shared {@link Dialog} width; setup appearance always uses the standard width. */
export type DialogSize = "standard" | "medium" | "large" | "wide";

/** Side inset for centered modals: 1rem each → usable width is viewport minus 2rem. */
export const centeredOverlayHorizontalInsetClassName = "w-[calc(100%-2rem)]";

/** Literal class strings so Tailwind can scan them (dynamic `` `max-w-[${px}px]` `` is not picked up). */
const dialogDesktopMaxWidthClassNameBySize = {
    standard: "max-w-[520px]",
    medium: "max-w-[680px]",
    large: "max-w-[840px]",
    wide: "max-w-[1024px]",
} as const satisfies Record<DialogSize, string>;

const dialogMobileSheetDesktopMaxWidthClassNameBySize = {
    standard: "sm:max-w-[520px]",
    medium: "sm:max-w-[680px]",
    large: "sm:max-w-[840px]",
    wide: "sm:max-w-[1024px]",
} as const satisfies Record<DialogSize, string>;

export const dialogStandardMaxWidthClassName = dialogDesktopMaxWidthClassNameBySize.standard;

export function sharedDialogDesktopMaxWidthClassName(size: DialogSize): string {
    return dialogDesktopMaxWidthClassNameBySize[size];
}

export function sharedDialogMobileSheetDesktopMaxWidthClassName(size: DialogSize): string {
    return dialogMobileSheetDesktopMaxWidthClassNameBySize[size];
}

export const executionDetailsDialogDesktopWidthClassName = "sm:w-[520px]";

export const agentConfigurationPopoverWidthClassName = "w-[min(calc(100vw-2rem),360px)]";
