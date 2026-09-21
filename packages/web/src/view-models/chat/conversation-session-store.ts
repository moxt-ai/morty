import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import type { OpenMobiusSession } from "./open-session.ts";

type ConversationSessionState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly conversationId: string;
          readonly session: OpenMobiusSession;
      }
    | { readonly kind: "failed"; readonly code: string | null; readonly message: string };

export interface ConversationSessionStore {
    readonly state: ConversationSessionState;
    readonly clear: () => void;
    readonly open: (botId: string, conversationId: string, signal: AbortSignal) => Promise<void>;
}

export function createConversationSessionStore(
    requests: Pick<BotChatApi, "access" | "conversationSession" | "workspaceDirectory">,
) {
    return createStore<ConversationSessionStore>()((set) => ({
        state: { kind: "idle" },
        clear: () => set({ state: { kind: "idle" } }),
        open: async (botId, conversationId, signal) => {
            set({ state: { kind: "loading" } });
            try {
                const access = await requests.access(botId, signal, conversationId);
                const directory = await requests.workspaceDirectory(botId, access.workspaceRef, signal);
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "ready",
                        conversationId: access.conversationId,
                        session: requests.conversationSession(access, { kind: "idle" }, directory.directoryLabel),
                    },
                });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "failed",
                        code: cause instanceof CloudApiError ? cause.code : null,
                        message: cause instanceof Error ? cause.message : "Session unavailable.",
                    },
                });
            }
        },
    }));
}
