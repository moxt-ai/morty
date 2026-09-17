import { createStore } from "zustand/vanilla";
import { ANONYMOUS_CREDENTIAL_KEY, AnonymousIdentityApi } from "@/services/identity/anonymous-identity-api";

type Handoff =
    | { readonly kind: "workspace" }
    | { readonly kind: "session"; readonly harness: string; readonly sessionId: string };
type NativeSessionChoice = "fork" | "import" | "skip";
type ContinueState =
    | {
          readonly kind: "confirm";
          readonly code: string;
          readonly handoff: Handoff;
          readonly replacesWorkspace: boolean;
      }
    | {
          readonly kind: "redeeming";
          readonly code: string;
          readonly handoff: Handoff;
          readonly choice: "workspace" | NativeSessionChoice;
      }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly continueSession: (choice: NativeSessionChoice) => void;
    readonly continueWorkspace: () => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
}

function initialState(): ContinueState {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    const query = new URLSearchParams(window.location.search);
    const harness = query.get("harness");
    const sessionId = query.get("sessionId");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
    if (
        code === null ||
        code.length === 0 ||
        (harness === null) !== (sessionId === null) ||
        (harness !== null && (!identifier.test(harness) || sessionId === null || !identifier.test(sessionId)))
    ) {
        return { kind: "invalid" };
    }
    const handoff: Handoff =
        harness === null || sessionId === null ? { kind: "workspace" } : { kind: "session", harness, sessionId };
    const replacesWorkspace = window.localStorage.getItem(ANONYMOUS_CREDENTIAL_KEY) !== null;
    if (handoff.kind === "session" || replacesWorkspace) {
        return { code, handoff, kind: "confirm", replacesWorkspace };
    }
    return { choice: "workspace", code, handoff, kind: "redeeming" };
}

export const createContinueStore = () =>
    createStore<ContinueStore>()((set, get) => ({
        state: initialState(),
        continueSession: (choice) => {
            const state = get().state;
            if (state.kind === "confirm" && state.handoff.kind === "session") {
                set({ state: { choice, code: state.code, handoff: state.handoff, kind: "redeeming" } });
            }
        },
        continueWorkspace: () => {
            const state = get().state;
            if (state.kind === "confirm" && state.handoff.kind === "workspace") {
                set({ state: { choice: "workspace", code: state.code, handoff: state.handoff, kind: "redeeming" } });
            }
        },
        redeem: async (signal) => {
            const state = get().state;
            if (state.kind !== "redeeming") {
                return;
            }
            const api = new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage });
            try {
                await api.redeemTransfer(state.code, signal);
                signal.throwIfAborted();
                if (state.handoff.kind === "workspace") {
                    window.location.replace("/");
                    return;
                }
                const destination = new URL("/", window.location.origin);
                if (state.choice !== "skip" && state.choice !== "workspace") {
                    destination.searchParams.set("harness", state.handoff.harness);
                    destination.searchParams.set("sessionId", state.handoff.sessionId);
                    destination.searchParams.set("nativeSessionAction", state.choice);
                }
                destination.searchParams.set("remoteAccess", "1");
                window.location.replace(destination);
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
