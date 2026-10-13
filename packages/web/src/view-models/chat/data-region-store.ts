import { createStore } from "zustand/vanilla";
import type { DataRegion } from "../../services/identity/anonymous-identity-api.ts";

type ReplacementState =
    | { readonly kind: "idle" }
    | { readonly kind: "replacing" }
    | { readonly kind: "failed"; readonly message: string };

export interface DataRegionStore {
    readonly location: DataRegion;
    readonly replacement: ReplacementState;
    readonly select: (location: DataRegion, signal: AbortSignal) => Promise<void>;
}

function dataRegionFromProjectId(projectId: string): DataRegion {
    const code = projectId.split("_", 3)[1];
    switch (code) {
        case "en":
            return "enam";
        case "sa":
            return "sam";
        case "we":
            return "weur";
        case "ee":
            return "eeur";
        case "an":
            return "apac-ne";
        case "as":
            return "apac-se";
        case "oc":
            return "oc";
        case "af":
            return "afr";
        case "me":
            return "me";
        case "wn":
            return "wnam";
        default:
            return "apac";
    }
}

export const createDataRegionStore = (
    projectId: string,
    replaceIdentity: (location: DataRegion, signal: AbortSignal) => Promise<void>,
) =>
    createStore<DataRegionStore>()((set, get) => ({
        location: dataRegionFromProjectId(projectId),
        replacement: { kind: "idle" },
        select: async (location, signal) => {
            if (location === get().location || get().replacement.kind === "replacing") {
                return;
            }
            set({ replacement: { kind: "replacing" } });
            try {
                await replaceIdentity(location, signal);
                signal.throwIfAborted();
                set({ location, replacement: { kind: "idle" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    replacement: {
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "The data region could not be changed.",
                    },
                });
            }
        },
    }));
