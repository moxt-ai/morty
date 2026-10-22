import { createStore } from "zustand/vanilla";
import { AnonymousIdentityApi, IdentityApiError } from "../../services/identity/anonymous-identity-api.ts";
import { readIdentityScope } from "../../services/identity/identity-scope-url.ts";
import { computerKey, rememberedComputers } from "../../services/identity/remembered-computers.ts";
import {
    accessEndedComputerEntry,
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "confirming-end"; readonly accessToken: string }
    | { readonly kind: "ending"; readonly accessToken: string }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly accessToken: string; readonly message: string };

interface RemoteAccessOperations {
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
}

export function createRemoteAccessOperations(options: {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly origin: string;
    readonly identity: {
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string>;
    };
    readonly onEnded: () => void;
}): RemoteAccessOperations {
    const api = new AnonymousIdentityApi(options);
    return {
        currentAccessToken: async (signal) => {
            const localIdentity = await api.loadExisting(signal);
            signal.throwIfAborted();
            return localIdentity?.projectId === options.identity.projectId
                ? localIdentity.token
                : await options.identity.getToken(signal);
        },
        endRemoteAccess: async (token, signal) => {
            const scope = readIdentityScope();
            const computer =
                scope === null
                    ? undefined
                    : rememberedComputers().find((entry) => computerKey(entry.scope) === computerKey(scope));
            await api.endRemoteAccess(token, signal);
            signal.throwIfAborted();
            centralSessionStorage.write(accessEndedNoticeEntry, "ended");
            centralSessionStorage.write(accessEndedComputerEntry, computer?.name || "the previous computer");
            options.onEnded();
        },
    };
}

export interface RemoteAccessStore {
    readonly state: RemoteAccessState;
    readonly requestEnd: (signal: AbortSignal) => Promise<void>;
    readonly cancel: () => void;
    readonly end: (signal: AbortSignal) => Promise<void>;
}

const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

export const createRemoteAccessStore = (operations: RemoteAccessOperations) =>
    createStore<RemoteAccessStore>()((set, get) => ({
        state: { kind: "available" },
        requestEnd: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const accessToken = await operations.currentAccessToken(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "confirming-end", accessToken } });
            } catch {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "unavailable",
                        message: "Couldn't prepare to end this access. Check your connection and try again.",
                    },
                });
            }
        },
        cancel: () => set({ state: { kind: "available" } }),
        end: async (signal) => {
            const state = get().state;
            if (state.kind !== "confirming-end" && state.kind !== "failed") {
                return;
            }
            set({ state: { kind: "ending", accessToken: state.accessToken } });
            try {
                await operations.endRemoteAccess(state.accessToken, operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "ended" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "failed",
                        accessToken: state.accessToken,
                        message:
                            cause instanceof IdentityApiError && cause.code === "UNAUTHENTICATED"
                                ? "This request was not authorized. Reload Morty to check your current access."
                                : "We couldn't confirm whether this access ended. Check your connection and try again.",
                    },
                });
            }
        },
    }));
