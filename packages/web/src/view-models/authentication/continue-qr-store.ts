import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";

const qrCodeWidth = 256;

type ContinueQrState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string }
    | { readonly kind: "failed" };

export interface ContinueQrStore {
    readonly state: ContinueQrState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createContinueQrStore = (url: string) =>
    createStore<ContinueQrStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const image = await QRCode.toDataURL(url, { margin: 1, width: qrCodeWidth });
                signal.throwIfAborted();
                set({ state: { image, kind: "ready" } });
            } catch {
                if (!signal.aborted) {
                    set({ state: { kind: "failed" } });
                }
            }
        },
    }));
