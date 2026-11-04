import { createStore } from "zustand/vanilla";

/** A title the user confirmed for a Session: waiting for the Runtime to take it, or the reason it did not. */
export type SessionRename =
    | { readonly kind: "none" }
    | { readonly kind: "pending"; readonly title: string }
    | { readonly kind: "failed"; readonly message: string };

export type SessionRenameStore = {
    readonly rename: SessionRename;
    readonly confirm: (title: string) => void;
    /** The Runtime took `title`. A title confirmed since stays pending. */
    readonly settled: (title: string) => void;
    /** Sending `title` failed. A title confirmed since stays pending. */
    readonly failed: (title: string, message: string) => void;
    readonly clear: () => void;
};

/**
 * The rename a Session holds. It belongs to the Session, not to the pane that took it, as a first message does: a
 * pane that stops before the Session connects leaves it pending, and the next pane that connects sends it.
 */
export function createSessionRenameStore() {
    return createStore<SessionRenameStore>()((set, get) => {
        const current = (title: string): boolean => {
            const rename = get().rename;
            return rename.kind === "pending" && rename.title === title;
        };
        return {
            rename: { kind: "none" },
            confirm: (title) => set({ rename: { kind: "pending", title } }),
            settled: (title) => {
                if (current(title)) {
                    set({ rename: { kind: "none" } });
                }
            },
            failed: (title, message) => {
                if (current(title)) {
                    set({ rename: { kind: "failed", message } });
                }
            },
            clear: () => set({ rename: { kind: "none" } }),
        };
    });
}
