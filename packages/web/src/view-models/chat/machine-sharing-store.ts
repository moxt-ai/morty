import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import type { IdentityTransfer } from "@/services/identity/anonymous-identity-api";

type MachineSharingState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string; readonly transfer: IdentityTransfer }
    | { readonly kind: "failed" };

export interface MachineSharingStore {
    readonly state: MachineSharingState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createMachineSharingStore = (createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>) =>
    createStore<MachineSharingStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const transfer = await createTransfer(signal);
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                signal.throwIfAborted();
                set({ state: { image, kind: "ready", transfer } });
            } catch {
                if (!signal.aborted) {
                    set({ state: { kind: "failed" } });
                }
            }
        },
    }));
