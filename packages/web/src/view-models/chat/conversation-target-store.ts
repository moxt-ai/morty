import { createStore } from "zustand/vanilla";
import type { ChatBot, ChatBotApi } from "@/services/bots/bot-api";

export type BotTargetDirectoryState =
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bots: readonly ChatBot[] }
    | { readonly kind: "failed"; readonly message: string };

export interface ConversationTargetStore {
    readonly botDirectory: BotTargetDirectoryState;
    readonly openBot: (bot: ChatBot, signal: AbortSignal) => Promise<void>;
    readonly refreshBots: (signal: AbortSignal) => Promise<void>;
}

export const createConversationTargetStore = (api: ChatBotApi, onOpenBot: (botId: string) => void) =>
    createStore<ConversationTargetStore>()((set, get) => ({
        botDirectory: { kind: "unavailable", message: "Open the Bots tab to load this workspace's Chat Bots." },
        openBot: async (bot, signal) => {
            await api.readBot(bot.botId, signal);
            signal.throwIfAborted();
            onOpenBot(bot.botId);
        },
        refreshBots: async (signal) => {
            if (get().botDirectory.kind === "loading") {
                return;
            }
            set({ botDirectory: { kind: "loading" } });
            try {
                const bots = await api.listBots(signal);
                signal.throwIfAborted();
                set({ botDirectory: { kind: "ready", bots } });
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        botDirectory: {
                            kind: "failed",
                            message:
                                error instanceof Error ? error.message : "The Chat Bot directory could not be loaded.",
                        },
                    });
                }
            }
        },
    }));
