import { createStore } from "zustand/vanilla";
import { AnonymousIdentityApi, hasStoredAnonymousCredential } from "@/services/identity/anonymous-identity-api";

type ContinueState =
    | { readonly kind: "confirm"; readonly code: string }
    | { readonly kind: "redeeming"; readonly code: string }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly continueWorkspace: () => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
}

function initialState(): ContinueState {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (code === null || code.length === 0 || query.has("harness") || query.has("sessionId")) {
        return { kind: "invalid" };
    }
    return hasStoredAnonymousCredential() ? { kind: "confirm", code } : { kind: "redeeming", code };
}

export const createContinueStore = (fetchRequest: (request: Request) => Promise<Response>) =>
    createStore<ContinueStore>()((set, get) => ({
        state: initialState(),
        continueWorkspace: () => {
            const state = get().state;
            if (state.kind === "confirm") {
                set({ state: { kind: "redeeming", code: state.code } });
            }
        },
        redeem: async (signal) => {
            const state = get().state;
            if (state.kind !== "redeeming") {
                return;
            }
            try {
                await new AnonymousIdentityApi({ fetchRequest, origin: window.location.origin }).redeemTransfer(
                    state.code,
                    signal,
                );
                signal.throwIfAborted();
                window.location.replace("/");
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "This transfer link is unavailable.",
                        },
                    });
                }
            }
        },
    }));
