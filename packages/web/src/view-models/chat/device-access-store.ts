import { createStore } from "zustand/vanilla";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { LinkedDevice, OpenWindowsAfterDisconnect } from "../../services/identity/anonymous-identity-api.ts";

/** The devices other than this browser that hold access, as the Worker last listed them. */
type DeviceList =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "listed"; readonly devices: readonly LinkedDevice[] };

/** What a disconnection reaches: one device, or every device but this browser and the computer. */
export type DisconnectTarget = { readonly kind: "device"; readonly id: string } | { readonly kind: "others" };

/** The disconnection in progress: one at a time, confirmed before it runs. */
type Disconnection =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming" | "disconnecting" | "failed"; readonly target: DisconnectTarget };

/** What the last finished disconnection reached; `name` is the device's, which has left the list by then. */
type Disconnected =
    | { readonly kind: "device"; readonly name: string; readonly openWindows: OpenWindowsAfterDisconnect }
    | { readonly kind: "others"; readonly openWindows: OpenWindowsAfterDisconnect };

type DeviceAccessState =
    | { readonly kind: "closed" }
    | {
          readonly kind: "open";
          readonly list: DeviceList;
          readonly disconnection: Disconnection;
          readonly disconnected: Disconnected | null;
      };

export interface DeviceAccessStore {
    readonly state: DeviceAccessState;
    /** Shows the devices with access, following changes while open. */
    readonly open: () => void;
    readonly close: () => void;
    /** Reads the list again after it could not be read. */
    readonly retry: () => void;
    /** Asks the user to confirm disconnecting `target`. */
    readonly request: (target: DisconnectTarget) => void;
    readonly cancel: () => void;
    /** Disconnects the confirmed target; repeating after a failure is safe. */
    readonly confirm: (signal: AbortSignal) => Promise<void>;
}

/**
 * The devices that hold access to this computer and the disconnections the user makes from them. The list has one
 * source, the Worker: every change, including one this browser makes, is read back rather than applied here.
 */
export function createDeviceAccessStore(options: {
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    /** Resolves once the devices differ from the list last read. */
    readonly waitForChange: (signal: AbortSignal) => Promise<void>;
    readonly waitForBridge: (signal: AbortSignal) => Promise<void>;
    readonly endDeviceAccess: (deviceId: string, signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
    /** Every other device is gone, so nothing the new-device notice announced remains. */
    readonly onOthersDisconnected: () => void;
    /** The workspace's operations; reading the devices ends with it. */
    readonly signal: () => AbortSignal;
}) {
    return createStore<DeviceAccessStore>()((set, get) => {
        let shown: AbortController | null = null;
        const update = (
            change: (state: Extract<DeviceAccessState, { readonly kind: "open" }>) => DeviceAccessState,
        ) => {
            const state = get().state;
            if (state.kind === "open") {
                set({ state: change(state) });
            }
        };
        const read = async (signal: AbortSignal): Promise<boolean> => {
            try {
                const devices = await options.linkedDevices(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
                if (!signal.aborted) {
                    update((state) => ({ ...state, list: { kind: "listed", devices } }));
                }
                return true;
            } catch {
                if (!signal.aborted) {
                    update((state) => ({ ...state, list: { kind: "failed" } }));
                }
                return false;
            }
        };
        /** Reads, then reads again whenever the list differs from that read, until the list closes. */
        const follow = async (signal: AbortSignal): Promise<void> => {
            while (await read(signal)) {
                try {
                    await options.waitForChange(signal);
                } catch (cause) {
                    if (signal.aborted || !isChatBridgeError(cause)) {
                        return;
                    }
                    try {
                        await options.waitForBridge(signal);
                    } catch {
                        return;
                    }
                }
            }
        };
        const show = () => {
            shown?.abort();
            shown = new AbortController();
            void follow(AbortSignal.any([options.signal(), shown.signal]));
        };
        return {
            state: { kind: "closed" },
            open: () => {
                set({
                    state: {
                        kind: "open",
                        list: { kind: "loading" },
                        disconnection: { kind: "idle" },
                        disconnected: null,
                    },
                });
                show();
            },
            close: () => {
                const state = get().state;
                if (state.kind === "open" && state.disconnection.kind === "disconnecting") {
                    return;
                }
                shown?.abort();
                shown = null;
                set({ state: { kind: "closed" } });
            },
            retry: () => {
                update((state) => ({ ...state, list: { kind: "loading" } }));
                show();
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
                const name =
                    target.kind === "device" && state.list.kind === "listed"
                        ? (state.list.devices.find((device) => device.id === target.id)?.label ?? "Unknown browser")
                        : "Unknown browser";
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
                                ? { kind: "device", name, openWindows }
                                : { kind: "others", openWindows },
                    }));
                    if (target.kind === "others") {
                        options.onOthersDisconnected();
                    }
                    show();
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
