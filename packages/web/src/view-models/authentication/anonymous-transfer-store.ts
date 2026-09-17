import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import { AnonymousIdentityApi, type IdentityTransfer } from "@/services/identity/anonymous-identity-api";

type AnonymousTransferState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string; readonly transfer: IdentityTransfer }
    | { readonly kind: "failed" };

export interface AnonymousTransferStore {
    readonly state: AnonymousTransferState;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly reset: () => void;
}

export const createAnonymousTransferStore = (
    token: string,
    createTransfer: (token: string, signal: AbortSignal) => Promise<IdentityTransfer> = new AnonymousIdentityApi({
        origin: window.location.origin,
        storage: window.localStorage,
    }).createTransfer,
) =>
    createStore<AnonymousTransferStore>()((set) => ({
        state: { kind: "idle" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const transfer = await createTransfer(token, signal);
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                signal.throwIfAborted();
                set({ state: { image, kind: "ready", transfer } });
            } catch {
                if (!signal.aborted) {
                    set({ state: { kind: "failed" } });
                }
            }
        },
        reset: () => set({ state: { kind: "idle" } }),
    }));
