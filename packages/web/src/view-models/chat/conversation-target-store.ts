import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

export type BotTargetDirectoryState =
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bots: readonly MobiusBot[] }
    | { readonly kind: "failed"; readonly message: string };

export interface ConversationTargetStore {
    readonly botDirectory: BotTargetDirectoryState;
    readonly createBotConversation: (bot: MobiusBot, signal: AbortSignal) => Promise<void>;
    readonly refreshBots: (signal: AbortSignal) => Promise<void>;
}

function directoryFailure(error: unknown): Extract<BotTargetDirectoryState, { readonly kind: "failed" }> {
    if (error instanceof MobiusApiError && error.code === "owner_access_required") {
        return { kind: "failed", message: "Owner access is required to start Bot conversations from this browser." };
    }
    if (error instanceof MobiusApiError) {
        return { kind: "failed", message: `${error.code}: ${error.message}` };
    }
    return { kind: "failed", message: "The Bot directory could not be loaded." };
}

export const createConversationTargetStore = (
    client: MobiusBotOwnerClient,
    onOpenBotConversation: (botId: string, conversationId: string) => void,
) =>
    createStore<ConversationTargetStore>()((set, get) => ({
        botDirectory: { kind: "unavailable", message: "Open the Bots tab to load this project's Bots." },
        createBotConversation: async (bot, signal) => {
            if (bot.state.kind !== "active") {
                throw new Error("Activate this Bot before starting a conversation.");
            }
            const conversation = await client.createConversation(
                bot.botId,
                { clientConversationKey: `web_${crypto.randomUUID()}` },
                signal,
            );
            signal.throwIfAborted();
            onOpenBotConversation(bot.botId, conversation.conversationId);
        },
        refreshBots: async (signal) => {
            if (get().botDirectory.kind === "loading") {
                return;
            }
            set({ botDirectory: { kind: "loading" } });
            try {
                const directory = await client.listBots(signal);
                signal.throwIfAborted();
                set({ botDirectory: { bots: directory.bots, kind: "ready" } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ botDirectory: directoryFailure(error) });
                }
            }
        },
    }));
