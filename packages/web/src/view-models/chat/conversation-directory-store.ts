import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "@/services/chat/bot-chat-api";

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "failed"; readonly message: string };

export interface ConversationDirectoryStore {
    readonly state: ConversationDirectoryState;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createConversationDirectoryStore = (botId: string, requests: Pick<BotChatApi, "managedSessions">) =>
    createStore<ConversationDirectoryStore>()((set) => ({
        state: { kind: "loading" },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const sessions = await requests.managedSessions(botId, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", sessions } });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "Conversations are unavailable.",
                        },
                    });
                }
            }
        },
    }));
