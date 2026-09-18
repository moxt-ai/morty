import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { useApiTransport } from "@/services/api/api-transport-context";
import { type ChatBot, ChatBotApi } from "@/services/bots/bot-api";
import {
    type BotTargetDirectoryState,
    createConversationTargetStore,
} from "@/view-models/chat/conversation-target-store";
import { useActiveIdentity } from "@/views/authentication/identity-context";

interface ConversationTargetContextValue {
    readonly botDirectory: BotTargetDirectoryState;
    readonly createBotConversation: (bot: ChatBot) => Promise<void>;
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
    onOpenBotConversation,
}: {
    readonly children: ReactNode;
    readonly onOpenBotConversation: (botId: string) => void;
}) {
    const identity = useActiveIdentity();
    const transport = useApiTransport();
    const [client] = useState(
        () =>
            new ChatBotApi({
                origin: window.location.origin,
                projectId: identity.projectId,
                getToken: identity.getToken,
                fetchRequest: transport.fetch,
                waitForChange: transport.waitForChange,
            }),
    );
    const [controller] = useState(() => new AbortController());
    const [store] = useState(() => createConversationTargetStore(client, onOpenBotConversation));
    const viewModel = useStore(store);

    useEffect(() => () => controller.abort(), [controller]);

    return (
        <ConversationTargetContext.Provider
            value={{
                botDirectory: viewModel.botDirectory,
                createBotConversation: async (bot) => await viewModel.openBot(bot, controller.signal),
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
