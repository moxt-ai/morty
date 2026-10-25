import { createStore } from "zustand/vanilla";
import { AnonymousIdentityApi, IdentityApiError } from "../../services/identity/anonymous-identity-api.ts";
import { readIdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerKey,
    rememberedComputers,
    storedTokenForProject,
    withStoredAccessLock,
} from "../../services/identity/remembered-computers.ts";
import {
    accessEndedComputerEntry,
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "confirming-end" }
    | { readonly kind: "ending" }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly message: string };

interface RemoteAccessOperations {
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    /** Ends the access this browser holds when it runs, while no other tab changes it. */
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
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
    const currentAccessToken = async (signal: AbortSignal): Promise<string> => {
        const localIdentity = await api.loadExisting(signal);
        signal.throwIfAborted();
        return localIdentity?.projectId === options.identity.projectId
            ? localIdentity.token
            : await options.identity.getToken(signal);
    };
    return {
        currentAccessToken,
        endRemoteAccess: async (signal) => {
            const scope = readIdentityScope();
            const computer =
                scope === null
                    ? undefined
                    : rememberedComputers().find((entry) => computerKey(entry.scope) === computerKey(scope));
            // Another tab may have replaced the access while the user confirmed; end the one held now. The Worker
            // checks it, so it is read without validating it again, which would wait for this same lock.
            await withStoredAccessLock(signal, async () =>
                api.endRemoteAccess(
                    storedTokenForProject(options.identity.projectId) ?? (await options.identity.getToken(signal)),
                    signal,
                ),
            );
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
                await operations.currentAccessToken(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "confirming-end" } });
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
            set({ state: { kind: "ending" } });
            try {
                await operations.endRemoteAccess(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "ended" } });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "failed",
                        message:
                            cause instanceof IdentityApiError && cause.code === "UNAUTHENTICATED"
                                ? "This request was not authorized. Reload Morty to check your current access."
                                : "We couldn't confirm whether this access ended. Check your connection and try again.",
                    },
                });
            }
        },
    }));
