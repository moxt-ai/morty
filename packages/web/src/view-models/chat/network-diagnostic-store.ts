import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";

type NetworkDiagnosticState =
    | { readonly kind: "closed" }
    | { readonly kind: "measuring" }
    | {
          readonly browserMortyLatencyMs: number;
          readonly kind: "ready";
          readonly runtimeLatencyMs: number;
      }
    | { readonly kind: "failed"; readonly message: string };

interface NetworkDiagnosticOperations {
    readonly measureBrowserMorty: (signal: AbortSignal) => Promise<number>;
    readonly measureServerHops: (signal: AbortSignal) => Promise<{
        readonly runtimeLatencyMs: number;
    }>;
}

export interface NetworkDiagnosticStore {
    readonly state: NetworkDiagnosticState;
    readonly close: () => void;
    readonly measure: (signal: AbortSignal) => Promise<void>;
}

export const createNetworkDiagnosticStore = (operations: NetworkDiagnosticOperations) => {
    let active: AbortController | null = null;
    return createStore<NetworkDiagnosticStore>()((set) => ({
        state: { kind: "closed" },
        close: () => {
            active?.abort(new DOMException("The network diagnostic was closed.", "AbortError"));
            active = null;
            set({ state: { kind: "closed" } });
        },
        measure: async (parent) => {
            active?.abort(new DOMException("A newer network diagnostic started.", "AbortError"));
            const controller = new AbortController();
            active = controller;
            const signal = AbortSignal.any([parent, controller.signal, AbortSignal.timeout(15_000)]);
            set({ state: { kind: "measuring" } });
            try {
                const [browserMortyLatencyMs, relay] = await Promise.all([
                    operations.measureBrowserMorty(signal),
                    operations.measureServerHops(signal),
                ]);
                signal.throwIfAborted();
                if (active === controller) {
                    set({
                        state: {
                            browserMortyLatencyMs,
                            kind: "ready",
                            runtimeLatencyMs: relay.runtimeLatencyMs,
                        },
                    });
                }
            } catch (cause) {
                parent.throwIfAborted();
                if (active === controller && !controller.signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: formatError(cause, "The network diagnostic failed."),
                        },
                    });
                }
            } finally {
                if (active === controller) {
                    active = null;
                }
            }
        },
    }));
};
