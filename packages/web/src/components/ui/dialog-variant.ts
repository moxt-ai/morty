import type { DialogSize } from "./overlay-width.ts";

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

type DialogVariantLayout = {
    readonly appearance: DialogAppearance;
    readonly mobileSheet: boolean;
    readonly size: DialogSize;
};

/**
 * Default width and shell choices when each product dialog is rendered.
 * `appearance="setup"` always uses the standard width regardless of `size`.
 */
const dialogVariantLayout: Record<DialogVariant, DialogVariantLayout> = {
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
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    connectAgentPairing: {
        appearance: "default",
        mobileSheet: false,
        size: "standard",
    },
    openSession: {
        appearance: "surface",
        mobileSheet: true,
        size: "large",
    },
};

export function resolveDialogGeneration(options: {
    readonly appearance?: DialogAppearance | undefined;
    readonly mobileSheet?: boolean | undefined;
    readonly size?: DialogSize | undefined;
    readonly variant?: DialogVariant | undefined;
}): {
    readonly appearance: DialogAppearance;
    readonly mobileSheet: boolean;
    readonly size: DialogSize;
} {
    const preset = options.variant !== undefined ? dialogVariantLayout[options.variant] : undefined;
    return {
        appearance: options.appearance ?? preset?.appearance ?? "default",
        mobileSheet: options.mobileSheet ?? preset?.mobileSheet ?? false,
        size: options.size ?? preset?.size ?? "standard",
    };
}
