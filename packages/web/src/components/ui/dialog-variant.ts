import { type DialogSize, overlayWidthPx, resolveDialogSize } from "./overlay-width.ts";

export type DialogAppearance = "default" | "setup" | "surface";

/** Product dialogs that use {@link Dialog}. Width tier lives here unless a call site overrides `size`. */
const dialogVariants = [
    "bugReport",
    "workingDirectory",
    "identitySharing",
    "networkLatency",
    "endAccess",
    "devicesAccess",
    "connectAgentPairing",
    "openSession",
] as const;

export type DialogVariant = (typeof dialogVariants)[number];

export type DialogVariantLayout = {
    readonly appearance: DialogAppearance;
    readonly mobileSheet: boolean;
    readonly size: DialogSize;
    /** Overrides default-appearance header bottom margin (`mb-5`). */
    readonly headerMarginBottomClassName?: "mb-3" | "mb-4";
    /** Overrides default-appearance description top margin (`mt-1.5`). */
    readonly descriptionMarginTopClassName?: "mt-0";
};

/**
 * Default width and shell choices when each product dialog is rendered.
 * `appearance="setup"` always uses {@link overlayWidthPx.dialogStandard} regardless of `size`.
 */
export const dialogVariantLayout: Record<DialogVariant, DialogVariantLayout> = {
    bugReport: {
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    workingDirectory: {
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    identitySharing: {
        appearance: "default",
        mobileSheet: false,
        size: "medium",
        headerMarginBottomClassName: "mb-3",
        descriptionMarginTopClassName: "mt-0",
    },
    networkLatency: {
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    endAccess: {
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    devicesAccess: {
        appearance: "surface",
        mobileSheet: false,
        size: "standard",
    },
    connectAgentPairing: {
        appearance: "setup",
        mobileSheet: false,
        size: "standard",
    },
    openSession: {
        appearance: "surface",
        mobileSheet: true,
        size: "large",
    },
};

const dialogVariantTitle: Record<DialogVariant, string> = {
    bugReport: "Report a bug",
    connectAgentPairing: "Connect agent",
    devicesAccess: "Devices with access",
    endAccess: "End current access?",
    identitySharing: "Continue on another device",
    networkLatency: "Network latency",
    openSession: "Open Session",
    workingDirectory: "Choose working directory",
};

function dialogSizeToOverlayWidthKey(size: DialogSize): keyof typeof overlayWidthPx {
    switch (size) {
        case "standard":
            return "dialogStandard";
        case "medium":
            return "dialogMedium";
        case "large":
            return "dialogLarge";
        case "wide":
            return "dialogWide";
    }
}

function dialogVariantDesktopWidthPx(variant: DialogVariant): number {
    const layout = dialogVariantLayout[variant];
    if (layout.appearance === "setup") {
        return overlayWidthPx.dialogStandard;
    }
    return overlayWidthPx[dialogSizeToOverlayWidthKey(layout.size)];
}

/** Playground / docs — variant id with resolved desktop width in px. */
export const dialogVariantCatalog: readonly {
    readonly title: string;
    readonly variant: DialogVariant;
    readonly widthPx: number;
}[] = dialogVariants.map((variant) => ({
    title: dialogVariantTitle[variant],
    variant,
    widthPx: dialogVariantDesktopWidthPx(variant),
}));

export function resolveDialogGeneration(options: {
    readonly appearance?: DialogAppearance | undefined;
    readonly mobileSheet?: boolean | undefined;
    readonly size?: DialogSize | undefined;
    readonly variant?: DialogVariant | undefined;
    readonly wide?: boolean | undefined;
}): {
    readonly appearance: DialogAppearance;
    readonly mobileSheet: boolean;
    readonly size: DialogSize;
} {
    const preset = options.variant !== undefined ? dialogVariantLayout[options.variant] : undefined;
    return {
        appearance: options.appearance ?? preset?.appearance ?? "default",
        mobileSheet: options.mobileSheet ?? preset?.mobileSheet ?? false,
        size: resolveDialogSize(options.size ?? preset?.size, options.wide ?? false),
    };
}
