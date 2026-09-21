import { createStore } from "zustand/vanilla";
import type { ChatBotApi, ChatBotDetail } from "@/services/bots/bot-api";

type BotWorkspaceState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bot: ChatBotDetail; readonly configured: boolean }
    | { readonly kind: "failed"; readonly message: string };

export interface BotWorkspaceStore {
    readonly state: BotWorkspaceState;
    readonly refreshing: boolean;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly refresh: (signal: AbortSignal) => Promise<ChatBotDetail>;
}

export const createBotWorkspaceStore = (api: ChatBotApi, botId: string) =>
    createStore<BotWorkspaceStore>()((set) => {
        const refresh = async (signal: AbortSignal): Promise<ChatBotDetail> => {
            set({ refreshing: true });
            try {
                const [bot, workspace] = await Promise.all([api.readBot(botId, signal), api.workspace(botId, signal)]);
                signal.throwIfAborted();
                set({ state: { kind: "ready", bot, configured: workspace.runtimeId !== null }, refreshing: false });
                return bot;
            } catch (error) {
                signal.throwIfAborted();
                set({ refreshing: false });
                throw error;
            }
        };
        return {
            state: { kind: "loading" },
            refreshing: false,
            load: async (signal) => {
                try {
                    await refresh(signal);
                } catch (error) {
                    if (!signal.aborted) {
                        set({
                            state: {
                                kind: "failed",
                                message: error instanceof Error ? error.message : "The Chat Bot could not be loaded.",
                            },
                            refreshing: false,
                        });
                    }
                }
            },
            refresh,
        };
    });
