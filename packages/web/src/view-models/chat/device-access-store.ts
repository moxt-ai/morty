import { createStore } from "zustand/vanilla";
import type { OpenWindowsAfterDisconnect } from "../../services/identity/anonymous-identity-api.ts";

/** What a disconnection reaches: one device, named as the list showed it, or every device but this browser and the computer. */
export type DisconnectTarget =
    | { readonly kind: "device"; readonly id: string; readonly name: string }
    | { readonly kind: "others" };

/** The disconnection in progress: one at a time, confirmed before it runs. */
type Disconnection =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming" | "disconnecting" | "failed"; readonly target: DisconnectTarget };

/** What the last finished disconnection reached; a device's name is kept because it has left the list by then. */
type Disconnected =
    | { readonly kind: "device"; readonly name: string; readonly openWindows: OpenWindowsAfterDisconnect }
    | { readonly kind: "others"; readonly openWindows: OpenWindowsAfterDisconnect };

type DeviceAccessState =
    | { readonly kind: "closed" }
    | { readonly kind: "open"; readonly disconnection: Disconnection; readonly disconnected: Disconnected | null };

export interface DeviceAccessStore {
    readonly state: DeviceAccessState;
    /** Shows the devices with access. */
    readonly open: () => void;
    readonly close: () => void;
    /** Asks the user to confirm disconnecting `target`. */
    readonly request: (target: DisconnectTarget) => void;
    readonly cancel: () => void;
    /** Disconnects the confirmed target; repeating after a failure is safe. */
    readonly confirm: (signal: AbortSignal) => Promise<void>;
}

/**
 * The Devices list's disconnections. The devices themselves are the page's one linked-device list: this store only
 * asks it to read again, when the list opens and after a disconnection changed it.
 */
export function createDeviceAccessStore(options: {
    readonly endDeviceAccess: (deviceId: string, signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    /** Reads the linked devices again. */
    readonly readDevices: () => void;
}) {
    return createStore<DeviceAccessStore>()((set, get) => {
        const update = (
            change: (state: Extract<DeviceAccessState, { readonly kind: "open" }>) => DeviceAccessState,
        ) => {
            const state = get().state;
            if (state.kind === "open") {
                set({ state: change(state) });
            }
        };
        return {
            state: { kind: "closed" },
            open: () => {
                set({ state: { kind: "open", disconnection: { kind: "idle" }, disconnected: null } });
                options.readDevices();
            },
            close: () => {
                const state = get().state;
                if (state.kind === "open" && state.disconnection.kind !== "disconnecting") {
                    set({ state: { kind: "closed" } });
                }
            },
            request: (target) => update((state) => ({ ...state, disconnection: { kind: "confirming", target } })),
            cancel: () =>
                update((state) =>
                    state.disconnection.kind === "disconnecting"
                        ? state
                        : { ...state, disconnection: { kind: "idle" } },
                ),
            confirm: async (signal) => {
                const state = get().state;
                if (
                    state.kind !== "open" ||
                    (state.disconnection.kind !== "confirming" && state.disconnection.kind !== "failed")
                ) {
                    return;
                }
                const target = state.disconnection.target;
                update((current) => ({ ...current, disconnection: { kind: "disconnecting", target } }));
                const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
                try {
                    const openWindows =
                        target.kind === "device"
                            ? await options.endDeviceAccess(target.id, bounded)
                            : await options.endOtherBrowserAccess(bounded);
                    signal.throwIfAborted();
                    update((current) => ({
                        ...current,
                        disconnection: { kind: "idle" },
                        disconnected:
                            target.kind === "device"
                                ? { kind: "device", name: target.name, openWindows }
                                : { kind: "others", openWindows },
                    }));
                    options.readDevices();
                } catch {
                    // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                    if (!signal.aborted) {
                        update((current) => ({ ...current, disconnection: { kind: "failed", target } }));
                    }
                }
            },
        };
    });
}
