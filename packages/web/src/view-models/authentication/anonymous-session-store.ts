import { createStore } from "zustand/vanilla";
import { type AnonymousIdentity, AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { hasIdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerAddress,
    hasStoredAccess,
    rememberComputerVisit,
    rememberedComputers,
} from "../../services/identity/remembered-computers.ts";
import {
    accessEndedComputerEntry,
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";
import { type Clock, systemClock } from "../../services/time/clock.ts";

export type ActiveAnonymousSession = {
    readonly kind: "active";
    readonly identity: AnonymousIdentity;
    readonly entry: "address" | "restore";
    readonly notice: string | null;
};

type AnonymousSessionState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "setup";
          readonly notice: "access-ended" | "legacy" | "none";
          readonly returnHref: string | null;
      }
    | ActiveAnonymousSession
    | { readonly kind: "invalid-link"; readonly continueHref: string | null }
    | { readonly kind: "failed" };

export interface AnonymousSessionStore {
    readonly state: AnonymousSessionState;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

/** The application owns and releases the workspace at these explicit transitions. */
export type AnnounceIdentity = (session: ActiveAnonymousSession | null) => void;

export const createAnonymousSessionStore = (
    fetchRequest: (request: Request) => Promise<Response>,
    origin: string,
    onIdentityChanged: AnnounceIdentity,
    clock: Clock = systemClock,
) =>
    createStore<AnonymousSessionStore>()((set, get) => {
        const api = new AnonymousIdentityApi({ fetchRequest, origin });
        const activate = (identity: AnonymousIdentity, entry: "address" | "restore", notice: string | null) => {
            rememberComputerVisit(identity, clock.now());
            const state: ActiveAnonymousSession = { kind: "active", identity, entry, notice };
            set({ state });
            onIdentityChanged(state);
        };
        return {
            state: { kind: "loading" },
            authorize: async (signal) => {
                const state = get().state;
                if (state.kind !== "active") {
                    throw new Error("Anonymous identity is unavailable.");
                }
                const current = await api.loadExisting(signal);
                if (current?.userId !== state.identity.userId) {
                    throw new Error("Anonymous identity changed.");
                }
            },
            load: async (signal) => {
                set({ state: { kind: "loading" } });
                onIdentityChanged(null);
                try {
                    if (window.location.pathname === "/setup" && !hasIdentityScope()) {
                        set({
                            state: {
                                kind: "setup",
                                notice: "none",
                                returnHref: rememberedComputers().length > 0 ? "/" : null,
                            },
                        });
                        return;
                    }
                    if (hasIdentityScope()) {
                        const identity = await api.loadExisting(signal);
                        signal.throwIfAborted();
                        if (identity === null) {
                            set({
                                state: {
                                    kind: "invalid-link",
                                    continueHref: rememberedComputers().length > 0 ? "/" : null,
                                },
                            });
                            return;
                        }
                        activate(identity, "address", null);
                        return;
                    }
                    const ended = centralSessionStorage.read(accessEndedNoticeEntry) === "ended";
                    const endedName = centralSessionStorage.read(accessEndedComputerEntry) ?? "the previous computer";
                    // Only the requested computer gates entry. An unrelated slow
                    // computer must not block a valid recent one.
                    for (const computer of rememberedComputers()) {
                        const identity = await api.loadScope(computer.scope, signal);
                        signal.throwIfAborted();
                        if (identity === null) {
                            continue;
                        }
                        const address = new URL(computerAddress(identity, computer.destination), origin);
                        window.history.replaceState(window.history.state, "", address);
                        centralSessionStorage.remove(accessEndedNoticeEntry);
                        centralSessionStorage.remove(accessEndedComputerEntry);
                        activate(
                            identity,
                            "restore",
                            ended
                                ? `Access to ${endedName} ended. You are now on ${computer.name || "your next computer"}.`
                                : null,
                        );
                        return;
                    }
                    centralSessionStorage.remove(accessEndedNoticeEntry);
                    centralSessionStorage.remove(accessEndedComputerEntry);
                    set({
                        state: {
                            kind: "setup",
                            notice: ended ? "access-ended" : hasStoredAccess() ? "legacy" : "none",
                            returnHref: null,
                        },
                    });
                } catch {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                }
            },
        };
    });
