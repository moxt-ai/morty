import { createStore } from "zustand/vanilla";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, hasIdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";

type AnonymousSessionState =
    | { readonly kind: "loading" }
    | { readonly kind: "setup"; readonly notice: "access-ended" | "none" }
    | { readonly kind: "active"; readonly identity: AnonymousIdentity }
    | { readonly kind: "choices"; readonly choices: readonly { readonly href: string; readonly label: string }[] }
    | { readonly kind: "failed" };

export interface AnonymousSessionStore {
    readonly state: AnonymousSessionState;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

/**
 * Announced from the explicit state transitions that leave or enter an
 * `active` identity, so the owner of the store reacts without subscribing to
 * it. `null` means the session no longer carries an identity.
 */
export type AnnounceIdentity = (identity: AnonymousIdentity | null) => void;

export const createAnonymousSessionStore = (
    fetchRequest: (request: Request) => Promise<Response>,
    origin: string,
    onIdentityChanged: AnnounceIdentity,
) =>
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
                onIdentityChanged(null);
                try {
                    if (window.location.pathname === "/setup" && !hasIdentityScope()) {
                        set({ state: { kind: "setup", notice: "none" } });
                        return;
                    }
                    const notice = centralSessionStorage.read(accessEndedNoticeEntry);
                    centralSessionStorage.remove(accessEndedNoticeEntry);
                    if (notice === "ended" && !hasIdentityScope()) {
                        set({ state: { kind: "setup", notice: "access-ended" } });
                        return;
                    }
                    if (hasIdentityScope()) {
                        const identity = await api.loadExisting(signal);
                        signal.throwIfAborted();
                        set({
                            state: identity === null ? { kind: "setup", notice: "none" } : { identity, kind: "active" },
                        });
                        onIdentityChanged(identity);
                        return;
                    }
                    const saved = await api.loadSaved(signal);
                    signal.throwIfAborted();
                    const access = saved[0];
                    if (access === undefined) {
                        set({ state: { kind: "setup", notice: "none" } });
                    } else if (saved.length === 1) {
                        api.saveIdentity(access.identity);
                        set({ state: { identity: access.identity, kind: "active" } });
                        onIdentityChanged(access.identity);
                    } else {
                        const choices = saved.map((candidate, index) => {
                            const parameters = new URLSearchParams({
                                identity: encodeIdentityScope(candidate.identity),
                            });
                            return {
                                href: `/chat?${parameters}`,
                                label: `${candidate.displayName} (access ${index + 1})`,
                            };
                        });
                        set({ state: { kind: "choices", choices } });
                    }
                } catch {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                }
            },
        };
    });
