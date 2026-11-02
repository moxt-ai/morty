import { createStore } from "zustand/vanilla";
import type { LinkedDevice, OpenWindowsAfterDisconnect } from "../../services/identity/anonymous-identity-api.ts";

/** The other devices the confirmation names: still being read, read, or not readable, which disconnecting allows. */
type OtherDevices =
    | { readonly kind: "loading" }
    | { readonly kind: "listed"; readonly devices: readonly LinkedDevice[] }
    | { readonly kind: "unavailable" };

type OtherDevicesState =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming"; readonly devices: OtherDevices }
    | { readonly kind: "disconnecting"; readonly devices: OtherDevices }
    | { readonly kind: "disconnected"; readonly openWindows: OpenWindowsAfterDisconnect }
    | { readonly kind: "failed"; readonly devices: OtherDevices; readonly message: string };

export interface OtherDevicesStore {
    readonly state: OtherDevicesState;
    /** Asks the user to confirm disconnecting every other device, naming the devices that would lose access. */
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
    /** The devices other than this browser that hold access through a link. */
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    readonly onDisconnected: () => void;
    /** The workspace's operations; reading the devices ends with it. */
    readonly signal: () => AbortSignal;
}) {
    return createStore<OtherDevicesStore>()((set, get) => {
        let confirmation: AbortController | null = null;
        const settleDevices = (devices: OtherDevices) => {
            const state = get().state;
            if (state.kind === "confirming" || state.kind === "disconnecting" || state.kind === "failed") {
                set({ state: { ...state, devices } });
            }
        };
        return {
            state: { kind: "idle" },
            request: () => {
                confirmation?.abort();
                const controller = new AbortController();
                confirmation = controller;
                set({ state: { kind: "confirming", devices: { kind: "loading" } } });
                const signal = AbortSignal.any([options.signal(), controller.signal, AbortSignal.timeout(15_000)]);
                void options.linkedDevices(signal).then(
                    (devices) => {
                        if (!signal.aborted) {
                            settleDevices({ kind: "listed", devices });
                        }
                    },
                    () => {
                        if (!controller.signal.aborted) {
                            settleDevices({ kind: "unavailable" });
                        }
                    },
                );
            },
            close: () => {
                if (get().state.kind !== "disconnecting") {
                    confirmation?.abort();
                    confirmation = null;
                    set({ state: { kind: "idle" } });
                }
            },
            disconnect: async (signal) => {
                const state = get().state;
                if (state.kind !== "confirming" && state.kind !== "failed") {
                    return;
                }
                set({ state: { kind: "disconnecting", devices: state.devices } });
                try {
                    const openWindows = await options.endOtherBrowserAccess(
                        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                    );
                    signal.throwIfAborted();
                    confirmation?.abort();
                    confirmation = null;
                    set({ state: { kind: "disconnected", openWindows } });
                    options.onDisconnected();
                } catch {
                    // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                    if (signal.aborted) {
                        return;
                    }
                    const current = get().state;
                    // Repeating is safe: devices already disconnected stay disconnected.
                    set({
                        state: {
                            kind: "failed",
                            devices: current.kind === "disconnecting" ? current.devices : { kind: "unavailable" },
                            message: "We couldn't confirm that the other devices were disconnected. Try again.",
                        },
                    });
                }
            },
        };
    });
}
