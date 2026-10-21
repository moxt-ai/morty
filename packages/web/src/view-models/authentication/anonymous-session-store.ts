import { createStore } from "zustand/vanilla";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, hasIdentityScope } from "../../services/identity/identity-scope-url.ts";
import { ManagementApi } from "../../services/management/management-api.ts";
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
                    const notice = centralSessionStorage.read(accessEndedNoticeEntry);
                    centralSessionStorage.remove(accessEndedNoticeEntry);
                    if (notice === "ended" && !hasIdentityScope()) {
                        set({ state: { kind: "setup", notice: "access-ended" } });
                        return;
                    }
                    const identities = hasIdentityScope()
                        ? [await api.loadExisting(signal)].filter((identity) => identity !== null)
                        : await api.loadSaved(signal);
                    signal.throwIfAborted();
                    const identity = identities[0];
                    if (identity === undefined) {
                        set({ state: { kind: "setup", notice: "none" } });
                    } else if (identities.length === 1) {
                        api.saveIdentity(identity);
                        set({ state: { identity, kind: "active" } });
                    } else {
                        const choices = await Promise.all(
                            identities.map(async (candidate, index) => {
                                const management = new ManagementApi({
                                    fetchRequest,
                                    origin,
                                    projectId: candidate.projectId,
                                    getToken: async (requestSignal) => {
                                        requestSignal.throwIfAborted();
                                        return candidate.token;
                                    },
                                });
                                const bot = await management.readBot(candidate.botId, signal);
                                const parameters = new URLSearchParams({ identity: encodeIdentityScope(candidate) });
                                return {
                                    href: `/chat?${parameters}`,
                                    label: `${bot.displayName} (access ${index + 1})`,
                                };
                            }),
                        );
                        signal.throwIfAborted();
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
