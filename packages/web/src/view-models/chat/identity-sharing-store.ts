import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import type { IdentityTransfer } from "@/services/identity/anonymous-identity-api";

type IdentitySharingState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly image: string; readonly transfer: IdentityTransfer }
    | { readonly kind: "failed" };

export interface IdentitySharingStore {
    readonly state: IdentitySharingState;
    /** Aborts the in-flight transfer creation when the sharing dialog closes. */
    readonly dispose: () => void;
}

/**
 * Starts loading the sharing transfer immediately. The store lives exactly as
 * long as the sharing dialog, so the dialog's close path owns cancellation.
 */
export const createIdentitySharingStore = (createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>) => {
    const controller = new AbortController();
    const store = createStore<IdentitySharingStore>()(() => ({
        dispose: () => controller.abort(new Error("Identity sharing closed.")),
        state: { kind: "loading" },
    }));
    void (async () => {
        try {
            const transfer = await createTransfer(controller.signal);
            const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
            controller.signal.throwIfAborted();
            store.setState({ state: { image, kind: "ready", transfer } });
        } catch {
            if (!controller.signal.aborted) {
                store.setState({ state: { kind: "failed" } });
            }
        }
    })();
    return store;
};
