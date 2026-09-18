import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "@/services/chat/bot-chat-api";

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "refreshing"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "stale"; readonly sessions: readonly ManagedChatSession[]; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

export interface ConversationDirectoryStore {
    readonly state: ConversationDirectoryState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createConversationDirectoryStore = (botId: string, requests: Pick<BotChatApi, "managedSessions">) =>
    createStore<ConversationDirectoryStore>()((set, get) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            const current = get().state;
            const cached =
                current.kind === "ready" || current.kind === "refreshing" || current.kind === "stale"
                    ? current.sessions
                    : null;
            set({ state: cached === null ? { kind: "loading" } : { kind: "refreshing", sessions: cached } });
            try {
                const sessions = await requests.managedSessions(botId, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", sessions } });
            } catch (cause) {
                if (!signal.aborted) {
                    const message = cause instanceof Error ? cause.message : "Conversations are unavailable.";
                    set({
                        state:
                            cached === null
                                ? { kind: "failed", message }
                                : { kind: "stale", message, sessions: cached },
                    });
                }
            }
        },
    }));
