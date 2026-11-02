import { createStore } from "zustand/vanilla";
import type { OpenWindowsAfterDisconnect } from "../../services/identity/anonymous-identity-api.ts";

type OtherDevicesState =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming" }
    | { readonly kind: "disconnecting" }
    | { readonly kind: "disconnected"; readonly openWindows: OpenWindowsAfterDisconnect }
    | { readonly kind: "failed"; readonly message: string };

export interface OtherDevicesStore {
    readonly state: OtherDevicesState;
    /** Asks the user to confirm disconnecting every other device. */
    readonly request: () => void;
    /** Closes the confirmation or its result. */
    readonly close: () => void;
    readonly disconnect: (signal: AbortSignal) => Promise<void>;
}

/**
 * Disconnects every other browser that joined this computer through a link while this one keeps its access, so the
 * owner can remove a device they did not add without locking themselves out.
 */
export function createOtherDevicesStore(options: {
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    readonly onDisconnected: () => void;
}) {
    return createStore<OtherDevicesStore>()((set, get) => ({
        state: { kind: "idle" },
        request: () => set({ state: { kind: "confirming" } }),
        close: () => {
            if (get().state.kind !== "disconnecting") {
                set({ state: { kind: "idle" } });
            }
        },
        disconnect: async (signal) => {
            const state = get().state;
            if (state.kind !== "confirming" && state.kind !== "failed") {
                return;
            }
            set({ state: { kind: "disconnecting" } });
            try {
                const openWindows = await options.endOtherBrowserAccess(
                    AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                );
                signal.throwIfAborted();
                set({ state: { kind: "disconnected", openWindows } });
                options.onDisconnected();
            } catch {
                // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                if (signal.aborted) {
                    return;
                }
                // Repeating is safe: devices already disconnected stay disconnected.
                set({
                    state: {
                        kind: "failed",
                        message: "We couldn't confirm that the other devices were disconnected. Try again.",
                    },
                });
            }
        },
    }));
}
