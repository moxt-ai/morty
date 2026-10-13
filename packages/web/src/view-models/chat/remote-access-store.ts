import { createStore } from "zustand/vanilla";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "loading" }
    | { readonly kind: "confirming-end"; readonly accessToken: string }
    | { readonly kind: "ending"; readonly accessToken: string }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly accessToken: string; readonly message: string };

interface RemoteAccessOperations {
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
}

export interface RemoteAccessStore {
    readonly state: RemoteAccessState;
    readonly requestEnd: (signal: AbortSignal) => Promise<void>;
    readonly cancel: () => void;
    readonly end: (signal: AbortSignal) => Promise<void>;
}

const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
const failureMessage = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export const createRemoteAccessStore = (operations: RemoteAccessOperations) =>
    createStore<RemoteAccessStore>()((set, get) => ({
        state: { kind: "available" },
        requestEnd: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const accessToken = await operations.currentAccessToken(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "confirming-end", accessToken } });
            } catch {
                signal.throwIfAborted();
                set({ state: { kind: "available" } });
            }
        },
        cancel: () => set({ state: { kind: "available" } }),
        end: async (signal) => {
            const state = get().state;
            if (state.kind !== "confirming-end" && state.kind !== "failed") {
                return;
            }
            set({ state: { kind: "ending", accessToken: state.accessToken } });
            try {
                await operations.endRemoteAccess(state.accessToken, operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "ended" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "failed",
                        accessToken: state.accessToken,
                        message: failureMessage(cause, "Remote access could not be ended."),
                    },
                });
            }
        },
    }));
