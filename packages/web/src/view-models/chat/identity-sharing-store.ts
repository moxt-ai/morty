import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import {
    type DeviceAccessDuration,
    IdentityApiError,
    type IdentityTransfer,
    type SharingTerms,
} from "@/services/identity/anonymous-identity-api";

type IdentitySharingState =
    | { readonly kind: "initial" }
    | {
          readonly kind: "loading" | "unconfirmed";
          readonly duration: DeviceAccessDuration | null;
          readonly request: SharingTerms;
      }
    | { readonly kind: "refused"; readonly duration: DeviceAccessDuration | null }
    | {
          readonly kind: "ready";
          readonly image: string;
          readonly transfer: IdentityTransfer;
          readonly replacedEarlier: boolean;
      };

export interface IdentitySharingStore {
    readonly state: IdentitySharingState;
    readonly start: (signal: AbortSignal) => void;
    readonly choose: (duration: DeviceAccessDuration) => void;
    readonly retry: () => void;
    readonly dispose: () => void;
}

function linkCode(transfer: IdentityTransfer): string {
    return new URLSearchParams(new URL(transfer.url).hash.slice(1)).get("code") ?? "";
}

/** The dialog owns one replacement chain. A newer choice waits for the current issuance to be confirmed. */
export const createIdentitySharingStore = (
    createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>,
) => {
    const lifetime = new AbortController();
    let signal = lifetime.signal;
    const store = createStore<IdentitySharingStore>(() => ({
        start: (parent) => {
            if (store.getState().state.kind !== "initial" || lifetime.signal.aborted) {
                return;
            }
            signal = AbortSignal.any([parent, lifetime.signal]);
            issue({ operationId: crypto.randomUUID(), accessDuration: null, replaces: null }, null);
        },
        choose: (duration) => {
            if (signal.aborted) {
                return;
            }
            const state = store.getState().state;
            switch (state.kind) {
                case "initial":
                case "refused":
                    return;
                case "loading":
                    // The selected term may change; the already issued operation keeps its original meaning.
                    store.setState({ state: { ...state, duration } });
                    return;
                case "unconfirmed":
                    issue(state.request, duration);
                    return;
                case "ready":
                    issue(
                        {
                            operationId: crypto.randomUUID(),
                            accessDuration: duration,
                            replaces: linkCode(state.transfer),
                        },
                        duration,
                    );
                    return;
            }
        },
        retry: () => {
            const state = store.getState().state;
            if (state.kind === "unconfirmed") {
                issue(state.request, state.duration);
            }
        },
        dispose: () => lifetime.abort(new Error("Identity sharing closed.")),
        state: { kind: "initial" },
    }));
    const issue = (request: SharingTerms, duration: DeviceAccessDuration | null) => {
        if (signal.aborted) {
            return;
        }
        store.setState({ state: { kind: "loading", duration, request } });
        void (async () => {
            try {
                const transfer = await createTransfer(request, signal);
                signal.throwIfAborted();
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                signal.throwIfAborted();
                const current = store.getState().state;
                if (current.kind !== "loading") {
                    return;
                }
                if (current.duration !== null && current.duration !== transfer.accessDuration) {
                    issue(
                        {
                            operationId: crypto.randomUUID(),
                            accessDuration: current.duration,
                            replaces: linkCode(transfer),
                        },
                        current.duration,
                    );
                    return;
                }
                store.setState({
                    state: { kind: "ready", image, transfer, replacedEarlier: request.replaces !== null },
                });
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                const current = store.getState().state;
                if (current.kind !== "loading") {
                    return;
                }
                const refused =
                    cause instanceof IdentityApiError &&
                    ["TRANSFER_CONFLICT", "UNAUTHENTICATED", "INVALID_REQUEST", "CREDENTIAL_KIND_REQUIRED"].includes(
                        cause.code,
                    );
                store.setState({
                    state: refused
                        ? { kind: "refused", duration: current.duration }
                        : { kind: "unconfirmed", duration: current.duration, request },
                });
            }
        })();
    };
    return store;
};
