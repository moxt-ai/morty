import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";
import { createSelectedBotPreference } from "@/services/bots/selected-bot-preference";
import { BotChatApi } from "@/services/chat/bot-chat-api";
import { AnonymousIdentityApi, hasStoredAnonymousCredential } from "@/services/identity/anonymous-identity-api";
import { ManagementApi } from "@/services/management/management-api";

export type NativeSessionImportAvailability =
    | { readonly kind: "available" }
    | { readonly kind: "unavailable"; readonly reason: string };
type SessionHandoff = {
    readonly harness: string;
    readonly importAvailability: NativeSessionImportAvailability;
    readonly sessionId: string;
};
type NativeSessionChoice = "fork" | "import" | "skip";
type ContinueState =
    | {
          readonly kind: "session-confirm";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly replacesWorkspace: boolean;
      }
    | {
          readonly kind: "session-redeeming";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly choice: NativeSessionChoice;
          readonly replacesWorkspace: boolean;
      }
    | {
          readonly kind: "session-failed";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly message: string;
          readonly replacesWorkspace: boolean;
      }
    | { readonly kind: "workspace-confirm"; readonly code: string }
    | { readonly kind: "workspace-redeeming"; readonly code: string }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly continueSession: (choice: NativeSessionChoice) => void;
    readonly continueWorkspace: () => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
}

function initialState(): ContinueState {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    const query = new URLSearchParams(window.location.search);
    const harness = query.get("harness");
    const sessionId = query.get("sessionId");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (
        code === null ||
        code.length === 0 ||
        (harness === null) !== (sessionId === null) ||
        (harness !== null && (!isIdentifier(harness) || sessionId === null || !isIdentifier(sessionId)))
    ) {
        return { kind: "invalid" };
    }
    const replacesWorkspace = hasStoredAnonymousCredential();
    if (harness !== null && sessionId !== null) {
        const importAvailability: NativeSessionImportAvailability =
            harness === "codex"
                ? {
                      kind: "unavailable",
                      reason: "The active Codex session owns the original thread. Fork it to continue in Morty.",
                  }
                : { kind: "available" };
        return {
            code,
            handoff: { harness, importAvailability, sessionId },
            kind: "session-confirm",
            replacesWorkspace,
        };
    }
    return replacesWorkspace ? { code, kind: "workspace-confirm" } : { code, kind: "workspace-redeeming" };
}

export const createContinueStore = (fetchRequest: (request: Request) => Promise<Response>) =>
    createStore<ContinueStore>()((set, get) => ({
        state: initialState(),
        continueSession: (choice) => {
            const state = get().state;
            if (state.kind === "session-confirm" || state.kind === "session-failed") {
                if (choice === "import" && state.handoff.importAvailability.kind === "unavailable") {
                    return;
                }
                set({
                    state: {
                        choice,
                        code: state.code,
                        handoff: state.handoff,
                        kind: "session-redeeming",
                        replacesWorkspace: state.replacesWorkspace,
                    },
                });
            }
        },
        continueWorkspace: () => {
            const state = get().state;
            if (state.kind === "workspace-confirm") {
                set({ state: { code: state.code, kind: "workspace-redeeming" } });
            }
        },
        redeem: async (signal) => {
            const state = get().state;
            if (state.kind !== "session-redeeming" && state.kind !== "workspace-redeeming") {
                return;
            }
            const api = new AnonymousIdentityApi({
                fetchRequest,
                origin: window.location.origin,
            });
            try {
                const identity = await api.redeemTransfer(state.code, signal);
                signal.throwIfAborted();
                if (state.kind === "workspace-redeeming") {
                    window.location.replace("/");
                    return;
                }
                const choice = state.choice;
                if (choice === "skip") {
                    window.location.replace("/");
                    return;
                }
                const management = new ManagementApi({
                    fetchRequest,
                    origin: window.location.origin,
                    projectId: identity.projectId,
                    getToken: async () => identity.token,
                });
                const bots = await management.listBots(signal);
                const preferredBot = createSelectedBotPreference(identity.projectId).read();
                const bot = bots.find((candidate) => candidate.botId === preferredBot) ?? bots[0];
                if (bot === undefined) {
                    throw new Error("Your Machine is unavailable.");
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
                        throw new Error("Workspace updates are unavailable while continuing this session.");
                    },
                });
                const session = await chat.continueNativeSession(
                    bot.botId,
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
                    const message = cause instanceof Error ? cause.message : "This transfer link is unavailable.";
                    set({
                        state:
                            state.kind === "session-redeeming"
                                ? {
                                      code: state.code,
                                      handoff: state.handoff,
                                      kind: "session-failed",
                                      message,
                                      replacesWorkspace: state.replacesWorkspace,
                                  }
                                : { kind: "failed", message },
                    });
                }
            }
        },
    }));
