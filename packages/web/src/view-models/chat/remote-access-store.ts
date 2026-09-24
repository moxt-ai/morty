import { createStore } from "zustand/vanilla";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "loading" }
    | { readonly kind: "confirming-end"; readonly accessToken: string; readonly token: string }
    | {
          readonly kind: "editing-replacement";
          readonly accessToken: string;
          readonly currentToken: string;
          readonly replacementToken: string;
      }
    | {
          readonly kind: "replacement-failed";
          readonly accessToken: string;
          readonly currentToken: string;
          readonly replacementToken: string;
          readonly message: string;
      }
    | { readonly kind: "ending"; readonly accessToken: string; readonly token: string }
    | {
          readonly kind: "replacing";
          readonly accessToken: string;
          readonly currentToken: string;
          readonly replacementToken: string;
      }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly accessToken: string; readonly token: string; readonly message: string };

interface RemoteAccessOperations {
    readonly currentToken: (signal: AbortSignal) => Promise<{ readonly accessToken: string; readonly token: string }>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
    readonly replaceCurrentUser: (currentToken: string, replacementToken: string, signal: AbortSignal) => Promise<void>;
}

export interface RemoteAccessStore {
    readonly state: RemoteAccessState;
    readonly requestEnd: (signal: AbortSignal) => Promise<void>;
    readonly requestReplacement: (signal: AbortSignal) => Promise<void>;
    readonly updateReplacementToken: (token: string) => void;
    readonly cancel: () => void;
    readonly end: (signal: AbortSignal) => Promise<void>;
    readonly replace: (signal: AbortSignal) => Promise<void>;
}

const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
const failureMessage = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export const createRemoteAccessStore = (operations: RemoteAccessOperations) =>
    createStore<RemoteAccessStore>()((set, get) => ({
        state: { kind: "available" },
        requestEnd: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const current = await operations.currentToken(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "confirming-end", ...current } });
            } catch {
                signal.throwIfAborted();
                set({ state: { kind: "available" } });
            }
        },
        requestReplacement: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const current = await operations.currentToken(operationSignal(signal));
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "editing-replacement",
                        accessToken: current.accessToken,
                        currentToken: current.token,
                        replacementToken: "",
                    },
                });
            } catch {
                signal.throwIfAborted();
                set({ state: { kind: "available" } });
            }
        },
        updateReplacementToken: (replacementToken) => {
            const state = get().state;
            if (state.kind === "editing-replacement" || state.kind === "replacement-failed") {
                set({
                    state: {
                        kind: "editing-replacement",
                        accessToken: state.accessToken,
                        currentToken: state.currentToken,
                        replacementToken,
                    },
                });
            }
        },
        cancel: () => set({ state: { kind: "available" } }),
        end: async (signal) => {
            const state = get().state;
            if (state.kind !== "confirming-end" && state.kind !== "failed") {
                return;
            }
            set({ state: { kind: "ending", accessToken: state.accessToken, token: state.token } });
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
                        token: state.token,
                        message: failureMessage(cause, "Remote access could not be ended."),
                    },
                });
            }
        },
        replace: async (signal) => {
            const state = get().state;
            if (state.kind !== "editing-replacement" && state.kind !== "replacement-failed") {
                return;
            }
            const replacementToken = state.replacementToken.trim();
            if (replacementToken.length === 0) {
                set({
                    state: {
                        kind: "replacement-failed",
                        accessToken: state.accessToken,
                        currentToken: state.currentToken,
                        replacementToken,
                        message: "Enter a replacement user token.",
                    },
                });
                return;
            }
            if (replacementToken === state.currentToken) {
                set({
                    state: {
                        kind: "replacement-failed",
                        accessToken: state.accessToken,
                        currentToken: state.currentToken,
                        replacementToken,
                        message: "Enter a different user token.",
                    },
                });
                return;
            }
            set({
                state: {
                    kind: "replacing",
                    accessToken: state.accessToken,
                    currentToken: state.currentToken,
                    replacementToken,
                },
            });
            try {
                await operations.replaceCurrentUser(state.accessToken, replacementToken, operationSignal(signal));
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "replacement-failed",
                        accessToken: state.accessToken,
                        currentToken: state.currentToken,
                        replacementToken,
                        message: failureMessage(cause, "The current user could not be replaced."),
                    },
                });
            }
        },
    }));
