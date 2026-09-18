import { createStore } from "zustand/vanilla";
import type { ChatBotApi } from "@/services/bots/bot-api";
import type { ManagedChatSession } from "@/services/chat/bot-chat-api";

export type BotConversationsState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "failed"; readonly message: string };

export const createBotConversationsStore = (api: ChatBotApi, botId: string) =>
    createStore<{ readonly state: BotConversationsState; readonly load: (signal: AbortSignal) => Promise<void> }>()(
        (set) => ({
            state: { kind: "loading" },
            load: async (signal) => {
                set({ state: { kind: "loading" } });
                try {
                    const sessions = await api.conversations(botId, signal);
                    signal.throwIfAborted();
                    set({ state: { kind: "ready", sessions } });
                } catch (error) {
                    if (!signal.aborted) {
                        set({
                            state: {
                                kind: "failed",
                                message: error instanceof Error ? error.message : "Bot conversations are unavailable.",
                            },
                        });
                    }
                }
            },
        }),
    );
