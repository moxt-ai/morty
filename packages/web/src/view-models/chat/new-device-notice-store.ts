import { createStore } from "zustand/vanilla";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import { centralLocalStorage, linkedDevicesSeenEntry } from "../../services/local-storage/central-local-storage.ts";

type NewDeviceNoticeState =
    | { readonly kind: "none" }
    | { readonly kind: "notice"; readonly devices: readonly LinkedDevice[] };

export interface NewDeviceNoticeStore {
    readonly state: NewDeviceNoticeState;
    /** Checks for new devices while the notice is shown: at once, and whenever the page becomes visible again. */
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    /** The user saw the new devices; only devices that join later are new to this browser. */
    readonly dismiss: () => void;
}

function latestJoin(devices: readonly LinkedDevice[]): string {
    return devices.reduce(
        (latest, device) => (Date.parse(device.joinedAt) > Date.parse(latest) ? device.joinedAt : latest),
        new Date(0).toISOString(),
    );
}

/**
 * What reading the devices means for a browser that last looked at `seenAt`, or never did: the notice to show and
 * when it has now looked through. A browser is not told about the devices that joined before it first looked.
 */
function readDevices(
    devices: readonly LinkedDevice[],
    seenAt: string | null,
): { readonly state: NewDeviceNoticeState; readonly seenAt: string } {
    if (seenAt === null) {
        return { state: { kind: "none" }, seenAt: latestJoin(devices) };
    }
    const joined = devices.filter((device) => Date.parse(device.joinedAt) > Date.parse(seenAt));
    return { state: joined.length === 0 ? { kind: "none" } : { kind: "notice", devices: joined }, seenAt };
}

/**
 * Tells this browser when another device joined its computer since it last looked, so the owner can notice a device
 * they did not add. Joining times come from the Worker, so this browser's clock does not decide what is new. While the
 * page is visible it follows the device list, so a device that joins through a link just shared shows up at once.
 */
export function createNewDeviceNoticeStore(options: {
    readonly projectId: string;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    /** Resolves once the device list differs from the one last read. */
    readonly waitForChange: (signal: AbortSignal) => Promise<void>;
    readonly waitForBridge: (signal: AbortSignal) => Promise<void>;
}) {
    const seen = linkedDevicesSeenEntry(options.projectId);
    return createStore<NewDeviceNoticeStore>()((set, get) => {
        /** Reads the devices and updates the notice; false when they could not be read. */
        const check = async (signal: AbortSignal): Promise<boolean> => {
            let devices: readonly LinkedDevice[];
            try {
                devices = await options.linkedDevices(signal);
            } catch {
                // The next visit checks again; access that ended is handled by the request that found it.
                return false;
            }
            if (signal.aborted) {
                return false;
            }
            const seenAt = centralLocalStorage.read(seen);
            const read = readDevices(devices, seenAt);
            if (read.seenAt !== seenAt) {
                centralLocalStorage.write(seen, read.seenAt);
            }
            set({ state: read.state });
            return true;
        };
        /**
         * Checks, then checks again whenever the list differs from that read, until the page is hidden. A list that
         * cannot be read stops following: the watch would otherwise report that same difference again at once.
         */
        const follow = async (signal: AbortSignal): Promise<void> => {
            while (await check(signal)) {
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
        return {
            state: { kind: "none" },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const lifetime = new AbortController();
                // A hidden page needs no live notice; it checks again once it is visible.
                let visible: AbortController | null = null;
                const followWhileVisible = () => {
                    visible?.abort();
                    visible = null;
                    if (document.visibilityState === "visible") {
                        visible = new AbortController();
                        void follow(AbortSignal.any([lifetime.signal, visible.signal]));
                    }
                };
                document.addEventListener("visibilitychange", followWhileVisible, { signal: lifetime.signal });
                followWhileVisible();
                return () => lifetime.abort();
            },
            dismiss: () => {
                const state = get().state;
                if (state.kind === "notice") {
                    centralLocalStorage.write(seen, latestJoin(state.devices));
                }
                set({ state: { kind: "none" } });
            },
        };
    });
}
