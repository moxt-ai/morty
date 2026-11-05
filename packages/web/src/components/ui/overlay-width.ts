/**
 * Centered overlay and anchored-panel width ladder for Morty Web.
 *
 * Adjust `overlayWidthPx` when design changes a tier; class helpers below stay in sync.
 *
 * Dialog rungs (desktop): 520 → 680 → 840 → 1024 (+160, +160, +184).
 *
 * Not in this ladder:
 * - Mobile bottom sheets (full viewport width)
 * - Fullscreen viewers (Mermaid, images) and file preview drawer
 * - Setup page cards (`setup-card-shell`: 460 / 960) — page layout, not Dialog
 */

export const overlayWidthPx = {
    /** Agent configuration popover on desktop (anchor panel, not centered Dialog). */
    popoverConfig: 360,
    /** Default centered dialog (`size="standard"`). */
    dialogStandard: 520,
    /** Roomier forms and two-column content (`size="medium"`). */
    dialogMedium: 680,
    /** Session lists and dense tables (`size="large"`). */
    dialogLarge: 840,
    /** Full-width dialog layouts (`size="wide"`). */
    dialogWide: 1024,
} as const;

export type OverlayWidthToken = keyof typeof overlayWidthPx;

/** Shared {@link Dialog} width; setup appearance always uses {@link overlayWidthPx.dialogStandard}. */
export type DialogSize = "standard" | "medium" | "large" | "wide";

/** Design / Playground reference — sorted narrow → wide. */
export const overlayWidthLadder: readonly {
    readonly token: OverlayWidthToken;
    readonly label: string;
    readonly usage: string;
}[] = [
    {
        token: "popoverConfig",
        label: "Popover · config",
        usage: "Agent configuration (desktop, anchored)",
    },
    {
        token: "dialogStandard",
        label: "Dialog · standard",
        usage: "Bug report, sharing, latency, cwd, devices, setup pairing, execution details, …",
    },
    {
        token: "dialogMedium",
        label: "Dialog · medium",
        usage: 'Reserved for denser forms (set `size="medium"` on Dialog)',
    },
    {
        token: "dialogLarge",
        label: "Dialog · large",
        usage: "Open Session (desktop)",
    },
    {
        token: "dialogWide",
        label: "Dialog · wide",
        usage: 'Maximum dialog width (`size="wide"`)',
    },
];

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

export function resolveDialogSize(size: DialogSize | undefined, wide: boolean): DialogSize {
    if (size !== undefined) {
        return size;
    }
    return wide ? "wide" : "standard";
}

export const dialogStandardMaxWidthClassName = dialogDesktopMaxWidthClassNameBySize.standard;

export function sharedDialogDesktopMaxWidthClassName(size: DialogSize): string {
    return dialogDesktopMaxWidthClassNameBySize[size];
}

export function sharedDialogMobileSheetDesktopMaxWidthClassName(size: DialogSize): string {
    return dialogMobileSheetDesktopMaxWidthClassNameBySize[size];
}

export const executionDetailsDialogWidthPx = overlayWidthPx.dialogStandard;

export const executionDetailsDialogDesktopWidthClassName = "sm:w-[520px]";

export const agentConfigurationPopoverWidthClassName = "w-[min(calc(100vw-2rem),360px)]";
