import { createStore } from "zustand/vanilla";
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
 * Tells this browser when another device joined its computer since it last looked, so the owner can notice a device
 * they did not add. Joining times come from the Worker, so this browser's clock does not decide what is new.
 */
export function createNewDeviceNoticeStore(options: {
    readonly projectId: string;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
}) {
    const seen = linkedDevicesSeenEntry(options.projectId);
    return createStore<NewDeviceNoticeStore>()((set, get) => {
        const check = async (signal: AbortSignal): Promise<void> => {
            let devices: readonly LinkedDevice[];
            try {
                devices = await options.linkedDevices(signal);
            } catch {
                // The next visit checks again; access that ended is handled by the request that found it.
                return;
            }
            if (signal.aborted) {
                return;
            }
            const seenAt = centralLocalStorage.read(seen);
            if (seenAt === null) {
                // A browser is not told about the devices that joined before it first looked.
                centralLocalStorage.write(seen, latestJoin(devices));
                return;
            }
            const joined = devices.filter((device) => Date.parse(device.joinedAt) > Date.parse(seenAt));
            set({ state: joined.length === 0 ? { kind: "none" } : { kind: "notice", devices: joined } });
        };
        return {
            state: { kind: "none" },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const lifetime = new AbortController();
                const checkWhenVisible = () => {
                    if (document.visibilityState === "visible") {
                        void check(lifetime.signal);
                    }
                };
                document.addEventListener("visibilitychange", checkWhenVisible, { signal: lifetime.signal });
                checkWhenVisible();
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
