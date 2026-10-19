import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import { BotChatApi } from "@/services/chat/bot-chat-api";
import { recordBrowserError, registerDaemonDiagnostics } from "@/services/diagnostics/browser-diagnostics";
import { AnonymousIdentityApi } from "@/services/identity/anonymous-identity-api";
import { formatError } from "@/view-models/format-error";

type SessionHandoff = {
    readonly harness: string;
    readonly sessionId: string;
};
type NativeSessionChoice = "fork" | "import" | "skip";
type ContinueState =
    | {
          readonly kind: "session-confirm";
          readonly code: string;
          readonly handoff: SessionHandoff;
      }
    | {
          readonly kind: "session-redeeming";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly choice: NativeSessionChoice;
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
    readonly continueSession: (choice: NativeSessionChoice) => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
    readonly dispose: () => void;
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
            kind: "session-confirm",
        };
    }
    return { code, kind: "identity-redeeming" };
}

export function continueCode(state: ContinueState): string | null {
    return state.kind === "invalid" || state.kind === "failed" ? null : state.code;
}

export function continueUrl(code: string): string {
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ code }).toString();
    return url.toString();
}

export const createContinueStore = (fetchRequest: (request: Request) => Promise<Response>) => {
    let releaseDiagnostics: (() => void) | null = null;
    const dispose = () => {
        releaseDiagnostics?.();
        releaseDiagnostics = null;
    };
    return createStore<ContinueStore>()((set, get) => ({
        dispose,
        state: initialState(),
        continueSession: (choice) => {
            const state = get().state;
            if (state.kind === "session-confirm" || state.kind === "session-failed") {
                set({
                    state: {
                        choice,
                        code: state.code,
                        handoff: state.handoff,
                        kind: "session-redeeming",
                    },
                });
            }
        },
        redeem: async (signal) => {
            const state = get().state;
            if (state.kind !== "session-redeeming" && state.kind !== "identity-redeeming") {
                return;
            }
            const api = new AnonymousIdentityApi({
                fetchRequest,
                origin: window.location.origin,
            });
            dispose();
            let operation = "redeem";
            try {
                const identity = await api.redeemTransfer(state.code, signal);
                signal.throwIfAborted();
                if (state.kind === "identity-redeeming") {
                    window.location.replace("/");
                    return;
                }
                const choice = state.choice;
                if (choice === "skip") {
                    window.location.replace("/");
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
                releaseDiagnostics = registerDaemonDiagnostics({
                    botId: identity.botId,
                    sessionId: null,
                    nativeSessionId: state.handoff.sessionId,
                    read: (parent) => chat.daemonDiagnostics(identity.botId, parent),
                });
                operation = "continue-native-session";
                const session = await chat.continueNativeSession(
                    identity.botId,
                    state.handoff.harness,
                    state.handoff.sessionId,
                    choice,
                    signal,
                );
                signal.throwIfAborted();
                const destination = new URL("/chat", window.location.origin);
                destination.searchParams.set("sessionId", session.result.ready.sessionId);
                window.location.replace(destination);
            } catch (cause) {
                if (!signal.aborted) {
                    recordBrowserError(operation, cause);
                    const message = formatError(cause, "This transfer link is unavailable.");
                    set({
                        state:
                            state.kind === "session-redeeming"
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
