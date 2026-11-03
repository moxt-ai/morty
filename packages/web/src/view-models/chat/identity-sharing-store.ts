import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import type { DeviceAccessDuration, IdentityTransfer, SharingTerms } from "@/services/identity/anonymous-identity-api";

type IdentitySharingState =
    /** `duration` is the one chosen, or null while the first link takes the Worker's default. */
    | { readonly kind: "loading"; readonly duration: DeviceAccessDuration | null }
    | {
          readonly kind: "ready";
          readonly image: string;
          readonly transfer: IdentityTransfer;
          /** Whether choosing these terms stopped an earlier link from this dialog working. */
          readonly replacedEarlier: boolean;
      }
    | { readonly kind: "failed"; readonly duration: DeviceAccessDuration | null };

export interface IdentitySharingStore {
    readonly state: IdentitySharingState;
    /** Shares a link whose device keeps access for `duration` instead; the link shown before stops working. */
    readonly choose: (duration: DeviceAccessDuration) => void;
    /** Aborts the in-flight transfer creation when the sharing dialog closes. */
    readonly dispose: () => void;
}

function linkCode(transfer: IdentityTransfer): string {
    return new URLSearchParams(new URL(transfer.url).hash.slice(1)).get("code") ?? "";
}

/**
 * Starts loading the sharing transfer immediately, with the Worker's default device access. The store lives exactly as long as
 * the sharing dialog, so the dialog's close path owns cancellation. Only one link it shared works at a time: choosing
 * other terms issues a new link that replaces the one shown.
 */
export const createIdentitySharingStore = (
    createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>,
) => {
    const lifetime = new AbortController();
    let attempt: AbortController | null = null;
    let shown: IdentityTransfer | null = null;
    const store = createStore<IdentitySharingStore>()(() => ({
        choose: (duration) => share(duration),
        dispose: () => lifetime.abort(new Error("Identity sharing closed.")),
        state: { kind: "loading", duration: null },
    }));
    const share = (duration: DeviceAccessDuration | null) => {
        attempt?.abort();
        const controller = new AbortController();
        attempt = controller;
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const replaces = shown;
        store.setState({ state: { kind: "loading", duration } });
        void (async () => {
            try {
                const transfer = await createTransfer(
                    { accessDuration: duration, replaces: replaces === null ? null : linkCode(replaces) },
                    signal,
                );
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                signal.throwIfAborted();
                shown = transfer;
                store.setState({
                    state: { kind: "ready", image, transfer, replacedEarlier: replaces !== null },
                });
            } catch {
                if (!signal.aborted) {
                    store.setState({ state: { kind: "failed", duration } });
                }
            }
        })();
    };
    share(null);
    return store;
};
