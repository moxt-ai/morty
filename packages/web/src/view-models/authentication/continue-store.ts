import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import { BotChatApi } from "@/services/chat/bot-chat-api";
import { type DaemonDiagnosticsSource, recordBrowserError } from "@/services/diagnostics/browser-diagnostics";
import { type AnonymousIdentity, AnonymousIdentityApi } from "@/services/identity/anonymous-identity-api";
import { encodeIdentityScope } from "@/services/identity/identity-scope-url";
import { formatError } from "@/view-models/format-error";

type SessionHandoff = {
    readonly harness: string;
    readonly sessionId: string;
};
type ContinueState =
    | {
          readonly kind: "session-opening";
          readonly code: string;
          readonly handoff: SessionHandoff;
      }
    | {
          readonly kind: "session-failed";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly message: string;
      }
    | { readonly kind: "identity-redeeming"; readonly code: string }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
    readonly retry: () => void;
    readonly diagnostics: DaemonDiagnosticsSource | null;
}

function initialState(): ContinueState {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    const query = new URLSearchParams(window.location.search);
    const harness = query.get("harness");
    const sessionId = query.get("sessionId");
    if (
        code === null ||
        code.length === 0 ||
        (harness === null) !== (sessionId === null) ||
        (harness !== null && (!isIdentifier(harness) || sessionId === null || !isIdentifier(sessionId)))
    ) {
        return { kind: "invalid" };
    }
    if (harness !== null && sessionId !== null) {
        return {
            code,
            handoff: { harness, sessionId },
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

export const createContinueStore = (fetchRequest: (request: Request) => Promise<Response>) => {
    return createStore<ContinueStore>()((set, get) => ({
        diagnostics: null,
        retry: () => {
            const state = get().state;
            if (state.kind === "session-failed") {
                set({
                    state: {
                        code: state.code,
                        handoff: state.handoff,
                        kind: "session-opening",
                    },
                });
            }
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
            let operation = "redeem";
            try {
                const identity = await api.redeemTransfer(state.code, signal);
                signal.throwIfAborted();
                if (state.kind === "identity-redeeming") {
                    window.location.replace(identityDestination("/", identity));
                    return;
                }
                const chat = new BotChatApi({
                    fetchRequest,
                    origin: window.location.origin,
                    projectId: identity.projectId,
                    getToken: async () => identity.token,
                    subscribe: async () => {
                        throw new Error("Session status updates are unavailable while continuing this session.");
                    },
                    waitForChange: async () => {
                        throw new Error("Runtime updates are unavailable while continuing this session.");
                    },
                });
                set({
                    diagnostics: {
                        botId: identity.botId,
                        sessionId: null,
                        nativeSessionId: state.handoff.sessionId,
                        read: (parent) => chat.daemonDiagnostics(identity.botId, parent),
                        readNetwork: (parent) => chat.networkDiagnostic(identity.botId, parent),
                    },
                });
                operation = "continue-native-session";
                const session = await chat.continueNativeSession(
                    identity.botId,
                    state.handoff.harness,
                    state.handoff.sessionId,
                    "import",
                    signal,
                );
                signal.throwIfAborted();
                const destination = identityDestination("/chat", identity);
                destination.searchParams.set("sessionId", session.result.ready.sessionId);
                window.location.replace(destination);
            } catch (cause) {
                if (!signal.aborted) {
                    recordBrowserError(operation, cause);
                    const message = formatError(cause, "This transfer link is unavailable.");
                    set({
                        state:
                            state.kind === "session-opening"
                                ? {
                                      code: state.code,
                                      handoff: state.handoff,
                                      kind: "session-failed",
                                      message,
                                  }
                                : { kind: "failed", message },
                    });
                }
            }
        },
    }));
};
