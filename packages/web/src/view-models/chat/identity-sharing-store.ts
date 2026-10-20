import QRCode from "qrcode";
import { createStore } from "zustand/vanilla";
import type { IdentityTransfer } from "@/services/identity/anonymous-identity-api";
import type { OpenMobiusSession } from "./open-session.ts";

type IdentitySharingState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly image: string;
          readonly transfer: IdentityTransfer;
          readonly handoff: { readonly kind: "available"; readonly prompt: string } | { readonly kind: "unavailable" };
      }
    | { readonly kind: "failed" };

export interface IdentitySharingStore {
    readonly state: IdentitySharingState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createIdentitySharingStore = (
    createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>,
    session: OpenMobiusSession | null,
) =>
    createStore<IdentitySharingStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const created = await createTransfer(signal);
                const url = new URL(created.url);
                if (session !== null) {
                    url.searchParams.set("sessionId", session.result.ready.sessionId);
                }
                const transfer = { ...created, url: url.toString() };
                const image = await QRCode.toDataURL(transfer.url, { margin: 1, width: 224 });
                signal.throwIfAborted();
                set({
                    state: {
                        image,
                        kind: "ready",
                        transfer,
                        handoff:
                            session === null
                                ? { kind: "unavailable" }
                                : {
                                      kind: "available",
                                      prompt: `Use curl to open this link: ${transfer.url}. Take over the remaining work by operating the agent in this session. I want to complete: [your goals].`,
                                  },
                    },
                });
            } catch {
                if (!signal.aborted) {
                    set({ state: { kind: "failed" } });
                }
            }
        },
    }));
