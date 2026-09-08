import { createStore } from "zustand/vanilla";
import type { Workspace } from "./contracts.ts";

type WorkspaceDialogState =
    | { readonly kind: "closed" }
    | { readonly kind: "create"; readonly name: string }
    | { readonly kind: "delete"; readonly workspace: Workspace };

interface WorkspaceUiState {
    readonly dialog: WorkspaceDialogState;
    readonly newWorkspace: () => void;
    readonly confirmDelete: (workspace: Workspace) => void;
    readonly setName: (name: string) => void;
    readonly closeDialog: () => void;
}

export function createWorkspaceStore() {
    return createStore<WorkspaceUiState>((set, get) => ({
        dialog: { kind: "closed" },
        newWorkspace: () => set({ dialog: { kind: "create", name: "" } }),
        confirmDelete: (workspace) => set({ dialog: { kind: "delete", workspace } }),
        setName: (name) => {
            if (get().dialog.kind === "create") {
                set({ dialog: { kind: "create", name } });
            }
        },
        closeDialog: () => set({ dialog: { kind: "closed" } }),
    }));
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
