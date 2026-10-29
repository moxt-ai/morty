import { createStore } from "zustand/vanilla";
import type { SetupHandoff } from "../services/device/setup-handoff.ts";

export type SendLinkStoreApi = ReturnType<typeof createSendLinkStore>;

type SendLinkState = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "failed" };

/** How the setup page moves setup to the agent's computer, as the view renders it. */
export type SetupHandoffModel =
    | { readonly kind: "copy-prompt" }
    | { readonly kind: "share"; readonly sendLink: SendLinkStoreApi }
    | { readonly kind: "copy-link" };

/**
 * Sends Morty's address to another device through the system share sheet. The application owns it: `close` ends
 * its lifetime, after which a share sheet that is still open can no longer change state or count a send.
 */
function createSendLinkStore(port: {
    readonly share: (data: ShareData) => Promise<void>;
    readonly onSent: () => void;
}) {
    const lifetime = new AbortController();
    return createStore<{
        readonly state: SendLinkState;
        readonly send: (data: ShareData) => void;
        readonly close: () => void;
    }>((set, get) => ({
        state: { kind: "idle" },
        send: (data) => {
            // A share sheet is already open; the browser rejects a second one.
            if (lifetime.signal.aborted || get().state.kind === "sending") {
                return;
            }
            set({ state: { kind: "sending" } });
            // Runs synchronously from the click, so the browser still sees the person's activation.
            void port.share(data).then(
                () => {
                    if (lifetime.signal.aborted) {
                        return;
                    }
                    set({ state: { kind: "idle" } });
                    port.onSent();
                },
                (cause: unknown) => {
                    if (lifetime.signal.aborted) {
                        return;
                    }
                    // Dismissing the share sheet is a cancellation, not a failure.
                    const dismissed = cause instanceof DOMException && cause.name === "AbortError";
                    set({ state: dismissed ? { kind: "idle" } : { kind: "failed" } });
                },
            );
        },
        close: () => lifetime.abort(),
    }));
}

/** The view model for this device's setup handoff; a share sheet gets a store that counts each completed send. */
export function setupHandoffModel(handoff: SetupHandoff, onSent: () => void): SetupHandoffModel {
    switch (handoff.kind) {
        case "copy-prompt":
            return { kind: "copy-prompt" };
        case "send-link":
            return handoff.share === null
                ? { kind: "copy-link" }
                : { kind: "share", sendLink: createSendLinkStore({ onSent, share: handoff.share }) };
    }
}
