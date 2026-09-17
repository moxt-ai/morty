import { createStore } from "zustand/vanilla";
import { createBrowserPairing, readBrowserPairingStatus } from "@/services/pairing/pairing-api";
import {
    type ChannelConnection,
    ConnectedBrowserPairingStatus,
    type CreatedPairing,
    ExpiredBrowserPairingStatus,
    PairingApiError,
} from "@/view-models/chat/channel";

const POLL_INTERVAL_MILLISECONDS = 1_200;
const CONNECTED_PAUSE_MILLISECONDS = 650;

type BrowserPairingState =
    | { readonly kind: "creating" }
    | { readonly kind: "waiting"; readonly pairing: CreatedPairing }
    | { readonly kind: "connected"; readonly machineName: string }
    | { readonly kind: "expired" }
    | { readonly kind: "failed"; readonly message: string };

export interface BrowserPairingStore {
    readonly state: BrowserPairingState;
    readonly run: (signal: AbortSignal) => Promise<void>;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, milliseconds);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createBrowserPairingStore = (
    getPairingToken: (signal: AbortSignal) => Promise<string | null>,
    onConnected: (connection: ChannelConnection) => void,
) =>
    createStore<BrowserPairingStore>()((set) => ({
        state: { kind: "creating" },
        run: async (lifetimeSignal) => {
            set({ state: { kind: "creating" } });
            try {
                const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(15_000)]);
                const token = await getPairingToken(signal);
                signal.throwIfAborted();
                const pairing = await createBrowserPairing(signal, token);
                lifetimeSignal.throwIfAborted();
                set({ state: { kind: "waiting", pairing } });
                while (!lifetimeSignal.aborted) {
                    await wait(POLL_INTERVAL_MILLISECONDS, lifetimeSignal);
                    lifetimeSignal.throwIfAborted();
                    const status = await readBrowserPairingStatus(pairing);
                    lifetimeSignal.throwIfAborted();
                    if (status instanceof ExpiredBrowserPairingStatus) {
                        set({ state: { kind: "expired" } });
                        return;
                    }
                    if (status instanceof ConnectedBrowserPairingStatus) {
                        set({ state: { kind: "connected", machineName: status.connection.machineName } });
                        await wait(CONNECTED_PAUSE_MILLISECONDS, lifetimeSignal);
                        lifetimeSignal.throwIfAborted();
                        onConnected(status.connection);
                        return;
                    }
                }
            } catch (error) {
                if (!lifetimeSignal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message:
                                error instanceof PairingApiError
                                    ? `${error.code}: ${error.message}`
                                    : "The pairing flow failed unexpectedly.",
                        },
                    });
                }
            }
        },
    }));
