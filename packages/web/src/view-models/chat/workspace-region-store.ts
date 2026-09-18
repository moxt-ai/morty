import { createStore } from "zustand/vanilla";
import type { WorkspaceLocation } from "../../services/identity/anonymous-identity-api.ts";

type ReplacementState =
    | { readonly kind: "idle" }
    | { readonly kind: "replacing" }
    | { readonly kind: "failed"; readonly message: string };

export interface WorkspaceRegionStore {
    readonly location: WorkspaceLocation;
    readonly replacement: ReplacementState;
    readonly select: (location: WorkspaceLocation, signal: AbortSignal) => Promise<void>;
}

function workspaceLocationFromProjectId(projectId: string): WorkspaceLocation {
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

export const createWorkspaceRegionStore = (
    projectId: string,
    replaceWorkspace: (location: WorkspaceLocation, signal: AbortSignal) => Promise<void>,
) =>
    createStore<WorkspaceRegionStore>()((set, get) => ({
        location: workspaceLocationFromProjectId(projectId),
        replacement: { kind: "idle" },
        select: async (location, signal) => {
            if (location === get().location || get().replacement.kind === "replacing") {
                return;
            }
            set({ replacement: { kind: "replacing" } });
            try {
                await replaceWorkspace(location, signal);
                signal.throwIfAborted();
                set({ location, replacement: { kind: "idle" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    replacement: {
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "The workspace region could not be changed.",
                    },
                });
            }
        },
    }));
