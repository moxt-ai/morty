import type { MobiusBot } from "@moxt-ai/mobius-sdk";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createBotOwnerClient } from "@/services/bots/bot-api";
import type { ChannelConnection } from "@/view-models/chat/channel";
import {
    type BotTargetDirectoryState,
    createConversationTargetStore,
} from "@/view-models/chat/conversation-target-store";

interface ConversationTargetContextValue {
    readonly botDirectory: BotTargetDirectoryState;
    readonly createBotConversation: (bot: MobiusBot) => Promise<void>;
    readonly refreshBots: () => Promise<void>;
}

const unavailableContext: ConversationTargetContextValue = {
    botDirectory: {
        kind: "unavailable",
        message: "Bot conversations are available from a paired Mobius Web workspace.",
    },
    createBotConversation: (): Promise<void> =>
        Promise.reject(new Error("Bot conversations are unavailable outside a paired Mobius Web workspace.")),
    refreshBots: (): Promise<void> => Promise.resolve(),
};

const ConversationTargetContext = createContext<ConversationTargetContextValue>(unavailableContext);

export function ConversationTargetProvider({
    children,
    connection,
    onOpenBotConversation,
}: {
    readonly children: ReactNode;
    readonly connection: ChannelConnection;
    readonly onOpenBotConversation: (botId: string, conversationId: string) => void;
}) {
    const [client] = useState(() => createBotOwnerClient(connection));
    const [controller] = useState(() => new AbortController());
    const [store] = useState(() => createConversationTargetStore(client, onOpenBotConversation));
    const viewModel = useStore(store);

    useEffect(() => () => controller.abort(), [controller]);

    return (
        <ConversationTargetContext.Provider
            value={{
                botDirectory: viewModel.botDirectory,
                createBotConversation: async (bot) => await viewModel.createBotConversation(bot, controller.signal),
                refreshBots: async () => await viewModel.refreshBots(controller.signal),
            }}
        >
            {children}
        </ConversationTargetContext.Provider>
    );
}

export function useConversationTargets(): ConversationTargetContextValue {
    return useContext(ConversationTargetContext);
}
