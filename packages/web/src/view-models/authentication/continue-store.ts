import { isIdentifier, MAX_WORKSPACE_PATH_LENGTH } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import { BotChatApi } from "@/services/chat/bot-chat-api";
import {
    readRecentCwdPreferences,
    saveLastCwdPreference,
    saveRecentCwdPreference,
} from "@/services/chat/last-cwd-preference";
import { pathDirectoryId } from "@/services/chat/workspace-directory-reference";
import { type DaemonDiagnosticsSource, recordBrowserError } from "@/services/diagnostics/browser-diagnostics";
import {
    type AnonymousIdentity,
    AnonymousIdentityApi,
    IdentityApiError,
} from "@/services/identity/anonymous-identity-api";
import { encodeIdentityScope, hasIdentityScope, readIdentityScope } from "@/services/identity/identity-scope-url";
import { computerKey, rememberedComputers } from "@/services/identity/remembered-computers";
import { centralSessionStorage, sessionWelcomeEntry } from "@/services/session-storage/central-session-storage";
import { formatError } from "@/view-models/format-error";

export type ContinueStoreApi = ReturnType<typeof createContinueStore>;

type SessionHandoff = {
    readonly harness: string;
    readonly sessionId: string;
    readonly workspace?: string;
};
export type ContinueState =
    | {
          readonly kind: "session-opening";
          readonly code: string;
          readonly handoff: SessionHandoff;
      }
    | {
          readonly kind: "session-resuming";
          readonly handoff: SessionHandoff;
          /** The redeemed access this attempt opens the session with. */
          readonly identity: AnonymousIdentity;
      }
    | {
          readonly kind: "session-failed";
          readonly handoff: SessionHandoff;
          readonly message: string;
          /**
           * The redeemed access. Opening the original session failed, but this
           * access still lets the user enter Morty home instead.
           */
          readonly identity: AnonymousIdentity;
      }
    | {
          readonly kind: "redeem-failed";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly message: string;
      }
    | { readonly kind: "link-unavailable"; readonly recovery: "setup" | "share"; readonly message: string }
    | { readonly kind: "identity-redeeming"; readonly code: string }
    | { readonly kind: "failed"; readonly code: string; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly continueHref: string | null;
    /** Aborts the in-flight redeem or session-open attempt, if any. */
    readonly cancel: () => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
    readonly retry: () => void;
    readonly enterMorty: () => void;
    readonly diagnostics: DaemonDiagnosticsSource | null;
}

function initialState(): ContinueState {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    const query = new URLSearchParams(window.location.search);
    const harness = query.get("harness");
    const sessionId = query.get("sessionId");
    const workspace = query.get("workspace");
    if (
        code === null ||
        code.length === 0 ||
        (workspace !== null &&
            (harness === null ||
                workspace.length === 0 ||
                workspace.length > MAX_WORKSPACE_PATH_LENGTH ||
                workspace.includes("\0"))) ||
        (harness === null) !== (sessionId === null) ||
        (harness !== null && (!isIdentifier(harness) || sessionId === null || !isIdentifier(sessionId)))
    ) {
        return { kind: "invalid" };
    }
    if (harness !== null && sessionId !== null) {
        return {
            code,
            handoff: { harness, sessionId, ...(workspace === null ? {} : { workspace }) },
            kind: "session-opening",
        };
    }
    return { code, kind: "identity-redeeming" };
}

/** A same-origin destination that carries the redeemed identity in its query string. */
function identityDestination(path: "/" | "/chat", identity: AnonymousIdentity): URL {
    const url = new URL(path, window.location.origin);
    url.searchParams.set(
        "identity",
        encodeIdentityScope({ botId: identity.botId, projectId: identity.projectId, userId: identity.userId }),
    );
    return url;
}

/**
 * The Project a well-formed transfer code names, or null when the code cannot
 * name one. A code that was already redeemed in this browser still names its
 * Project, which is what lets a dead link fall back to the access it issued.
 */
function transferCodeProject(code: string): string | null {
    const parts = code.split(".");
    return parts.length === 3 && parts[0] === "mobius_transfer_v2" ? (parts[1] ?? null) : null;
}

/**
 * Redeeming a transfer code is the only way to obtain access for a link that
 * was never opened in this browser. Once a link has been redeemed here, its
 * access stays usable even after the link itself expires or is revoked, so a
 * failed redemption falls back to the access this browser still holds for the
 * same Project.
 */
export const createContinueStore = (fetchRequest: (request: Request) => Promise<Response>) => {
    let attempt: AbortController | null = null;
    const store = createStore<ContinueStore>()((set, get) => {
        const showRetryableFailure = (
            state: Extract<ContinueState, { readonly kind: "session-opening" | "identity-redeeming" }>,
            cause: unknown,
        ) => {
            const message = formatError(cause, "Check your connection and try again.");
            set({
                continueHref: rememberedComputers().length > 0 ? "/" : null,
                state:
                    state.kind === "identity-redeeming"
                        ? { kind: "failed", code: state.code, message }
                        : { kind: "redeem-failed", code: state.code, handoff: state.handoff, message },
            });
        };
        /**
         * Opens the handoff session with an already-redeemed access. The
         * identity stays in the resulting states, so a retry reuses it instead
         * of redeeming the transfer code again.
         */
        const openSession = async (
            handoff: SessionHandoff,
            identity: AnonymousIdentity,
            signal: AbortSignal,
        ): Promise<void> => {
            set({
                diagnostics: null,
                state: { handoff, identity, kind: "session-resuming" },
            });
            const chat = new BotChatApi({
                fetchRequest,
                origin: window.location.origin,
                projectId: identity.projectId,
                getToken: async () => identity.token,
                subscribe: async () => {
                    throw new Error("Session status updates are unavailable while continuing this session.");
                },
                recoverBridge: async (signal) => signal.throwIfAborted(),
                waitForBridge: async () => {
                    throw new Error("Bridge updates are unavailable while continuing this session.");
                },
                waitForChange: async () => {
                    throw new Error("Runtime updates are unavailable while continuing this session.");
                },
            });
            set({
                diagnostics: {
                    botId: identity.botId,
                    sessionId: null,
                    nativeSessionId: handoff.sessionId,
                    read: (parent) => chat.daemonDiagnostics(identity.botId, parent),
                    readNetwork: (parent) => chat.networkDiagnostic(identity.botId, parent),
                },
            });
            try {
                if (handoff.workspace !== undefined) {
                    // A handoff supplies a requested path, never filesystem authority.
                    // Resolve it through the Runtime before recording a browser preference.
                    const configuration = await chat.runtimeConfiguration(identity.botId, signal);
                    const directory = await chat.directory(identity.botId, pathDirectoryId(handoff.workspace), signal);
                    signal.throwIfAborted();
                    saveLastCwdPreference(
                        identity.botId,
                        configuration.runtime.runtimeId,
                        handoff.harness,
                        directory.directoryId,
                    );
                    saveRecentCwdPreference(
                        identity.botId,
                        { directoryId: directory.directoryId, directoryLabel: directory.directoryLabel },
                        readRecentCwdPreferences(identity.botId) ?? [],
                    );
                }
                const session = await chat.continueNativeSession(
                    identity.botId,
                    handoff.harness,
                    handoff.sessionId,
                    "import",
                    signal,
                );
                signal.throwIfAborted();
                const visited = rememberedComputers().some(
                    (computer) => computerKey(computer.scope) === computerKey(identity) && computer.lastUsedAt > 0,
                );
                if (!visited) {
                    centralSessionStorage.write(
                        sessionWelcomeEntry(identity.botId, session.result.ready.sessionId),
                        "pending",
                    );
                }
                const destination = identityDestination("/chat", identity);
                destination.searchParams.set("sessionId", session.result.ready.sessionId);
                window.location.replace(destination);
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                recordBrowserError("continue-native-session", cause);
                set({
                    state: {
                        handoff,
                        identity,
                        kind: "session-failed",
                        message: formatError(cause, "This transfer link is unavailable."),
                    },
                });
            }
        };
        return {
            diagnostics: null,
            continueHref: rememberedComputers().length > 0 ? "/" : null,
            enterMorty: () => {
                const state = get().state;
                if (state.kind === "session-failed") {
                    window.location.replace(identityDestination("/", state.identity));
                }
            },
            cancel: () => {
                attempt?.abort(new Error("The continuation was cancelled."));
            },
            retry: () => {
                const state = get().state;
                if (state.kind !== "session-failed" && state.kind !== "redeem-failed" && state.kind !== "failed") {
                    return;
                }
                attempt?.abort(new Error("The transfer retry replaced this attempt."));
                attempt = new AbortController();
                if (state.kind === "session-failed") {
                    // The redeemed access, not the transfer code, owns this
                    // retry: the link may be gone while the access still works.
                    void openSession(state.handoff, state.identity, attempt.signal);
                    return;
                }
                set({
                    state:
                        state.kind === "failed"
                            ? { code: state.code, kind: "identity-redeeming" }
                            : {
                                  code: state.code,
                                  handoff: state.handoff,
                                  kind: "session-opening",
                              },
                });
                void get().redeem(attempt.signal);
            },
            state: initialState(),
            redeem: async (signal) => {
                const state = get().state;
                if (state.kind !== "session-opening" && state.kind !== "identity-redeeming") {
                    return;
                }
                const api = new AnonymousIdentityApi({
                    fetchRequest,
                    origin: window.location.origin,
                });
                set({ diagnostics: null });
                let identity: AnonymousIdentity;
                try {
                    identity = await api.redeemTransfer(state.code, signal);
                    signal.throwIfAborted();
                } catch (cause) {
                    if (signal.aborted) {
                        return;
                    }
                    recordBrowserError("redeem", cause);
                    const message = formatError(cause, "This transfer link is unavailable.");
                    // A dead transfer code does not revoke an access it already
                    // issued. Validate only the explicit scope, or a remembered
                    // scope for this exact Project when the old link has no scope.
                    if (cause instanceof IdentityApiError && cause.code === "TRANSFER_UNAVAILABLE") {
                        const projectId = transferCodeProject(state.code);
                        const explicit = readIdentityScope();
                        const scopes = hasIdentityScope()
                            ? explicit === null
                                ? []
                                : [explicit]
                            : rememberedComputers().map((computer) => computer.scope);
                        const matching = scopes.filter((scope) => scope.projectId === projectId);
                        const visited = new Set<string>();
                        try {
                            for (const scope of matching) {
                                if (visited.has(computerKey(scope))) {
                                    continue;
                                }
                                visited.add(computerKey(scope));
                                const retained = await api.loadScope(scope, signal);
                                signal.throwIfAborted();
                                if (retained === null) {
                                    continue;
                                }
                                if (state.kind === "identity-redeeming") {
                                    window.location.replace(identityDestination("/", retained));
                                } else {
                                    await openSession(state.handoff, retained, signal);
                                }
                                return;
                            }
                        } catch (retainedCause) {
                            if (signal.aborted) {
                                return;
                            }
                            recordBrowserError("load-retained-identity", retainedCause);
                            // The code is terminal, but checking independently
                            // retained access can still succeed after reconnecting.
                            showRetryableFailure(state, retainedCause);
                            return;
                        }
                        set({
                            continueHref: rememberedComputers().length > 0 ? "/" : null,
                            state: {
                                kind: "link-unavailable",
                                recovery: state.kind === "session-opening" ? "setup" : "share",
                                message,
                            },
                        });
                        return;
                    }
                    showRetryableFailure(state, cause);
                    return;
                }
                if (state.kind === "identity-redeeming") {
                    window.location.replace(identityDestination("/", identity));
                    return;
                }
                await openSession(state.handoff, identity, signal);
            },
        };
    });
    // The transfer page's lifetime starts the redeem as soon as the page's
    // store exists; the first state write happens after its first await, so
    // creation stays render-safe.
    attempt = new AbortController();
    void store.getState().redeem(attempt.signal);
    return store;
};
