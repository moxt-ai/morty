import { createStore } from "zustand/vanilla";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";

type AnonymousSessionState =
    | { readonly kind: "loading" }
    | { readonly kind: "active"; readonly identity: AnonymousIdentity }
    | { readonly kind: "failed" };

export interface AnonymousSessionStore {
    readonly state: AnonymousSessionState;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createAnonymousSessionStore = (fetchRequest: (request: Request) => Promise<Response>, origin: string) =>
    createStore<AnonymousSessionStore>()((set, get) => {
        const api = new AnonymousIdentityApi({ fetchRequest, origin });
        return {
            state: { kind: "loading" },
            authorize: async (signal) => {
                const state = get().state;
                if (state.kind !== "active") {
                    throw new Error("Anonymous identity is unavailable.");
                }
                const current = await api.loadOrCreate(signal);
                if (current.userId !== state.identity.userId) {
                    throw new Error("Anonymous identity changed.");
                }
            },
            load: async (signal) => {
                set({ state: { kind: "loading" } });
                try {
                    const existing = await api.loadExisting(signal);
                    signal.throwIfAborted();
                    const identity = existing ?? (await api.loadOrCreate(signal));
                    signal.throwIfAborted();
                    set({ state: { identity, kind: "active" } });
                } catch {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                }
            },
        };
    });
