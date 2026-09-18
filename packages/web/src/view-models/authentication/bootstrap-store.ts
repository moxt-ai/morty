import { createStore } from "zustand/vanilla";
import { getPublicConfig } from "@/view-models/authentication/config";

type BootstrapState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly publishableKey: string }
    | { readonly kind: "failed" };

export interface BootstrapStore {
    readonly state: BootstrapState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createBootstrapStore = (
    fetchRequest: (request: Request) => Promise<Response>,
    reportFailure: (error: unknown) => void,
) =>
    createStore<BootstrapStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const { publishableKey } = await getPublicConfig(fetchRequest, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", publishableKey } });
            } catch (error) {
                if (!signal.aborted) {
                    reportFailure(error);
                    set({ state: { kind: "failed" } });
                }
            }
        },
    }));
