import { createStore } from "zustand/vanilla";
import {
    readChannelConnection,
    readChannelHistory,
    redeemChannelAccessGrantFromLocation,
} from "@/services/pairing/pairing-api";
import type { ChannelConnection, ChannelHistory } from "@/view-models/chat/channel";
import { isIdentifier, PairingApiError } from "@/view-models/chat/channel";

type ChannelRouteState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly connection: ChannelConnection; readonly history: ChannelHistory }
    | { readonly kind: "failed"; readonly message: string };

export interface ChannelRouteStore {
    readonly state: ChannelRouteState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createChannelRouteStore = (channelId: string) =>
    createStore<ChannelRouteStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            if (!isIdentifier(channelId)) {
                set({ state: { kind: "failed", message: "The channel route is malformed." } });
                return;
            }
            set({ state: { kind: "loading" } });
            try {
                await redeemChannelAccessGrantFromLocation(channelId, signal);
                // Validate channel-scoped access before the broader project history read.
                const connection = await readChannelConnection(channelId, signal);
                const history = await readChannelHistory(channelId);
                signal.throwIfAborted();
                set({ state: { connection, history, kind: "ready" } });
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message:
                                error instanceof PairingApiError
                                    ? `${error.code}: ${error.message}`
                                    : "The channel could not be loaded.",
                        },
                    });
                }
            }
        },
    }));
