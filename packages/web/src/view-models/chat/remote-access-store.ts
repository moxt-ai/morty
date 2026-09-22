import { createStore } from "zustand/vanilla";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "confirming" }
    | { readonly kind: "ending" }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly message: string };

export interface RemoteAccessStore {
    readonly state: RemoteAccessState;
    readonly requestEnd: () => void;
    readonly cancelEnd: () => void;
    readonly end: (signal: AbortSignal) => Promise<void>;
}

export const createRemoteAccessStore = (endRemoteAccess: (signal: AbortSignal) => Promise<void>) =>
    createStore<RemoteAccessStore>()((set, get) => ({
        state: { kind: "available" },
        requestEnd: () => set({ state: { kind: "confirming" } }),
        cancelEnd: () => set({ state: { kind: "available" } }),
        end: async (signal) => {
            if (get().state.kind === "ending" || get().state.kind === "ended") {
                return;
            }
            set({ state: { kind: "ending" } });
            try {
                await endRemoteAccess(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
                signal.throwIfAborted();
                set({ state: { kind: "ended" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Remote access could not be ended.",
                    },
                });
            }
        },
    }));
