/**
 * Centered overlay and anchored-panel width ladder for Morty Web.
 *
 * Dialog rungs (desktop): standard 520 → medium 680 → sheet 840; the agent configuration popover is 360.
 *
 * Not in this ladder:
 * - Mobile bottom sheets (full viewport width)
 * - Fullscreen viewers (Mermaid, images) and file preview drawer
 * - Setup page cards (`setup-card-shell`: 460) — page layout, not Dialog
 */

/** Side inset for centered modals: 1rem each → usable width is viewport minus 2rem. */
export const centeredOverlayHorizontalInsetClassName = "w-[calc(100%-2rem)]";

/** Literal class strings so Tailwind can scan them (dynamic `` `max-w-[${px}px]` `` is not picked up). */
export const dialogDesktopMaxWidthClassName = {
    standard: "max-w-[520px]",
    medium: "max-w-[680px]",
} as const;

export const sheetDialogDesktopMaxWidthClassName = "sm:max-w-[840px]";

export const executionDetailsDialogDesktopWidthClassName = "sm:w-[520px]";

export const agentConfigurationPopoverWidthClassName = "w-[min(calc(100vw-2rem),360px)]";
