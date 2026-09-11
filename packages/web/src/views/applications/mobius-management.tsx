import { useMemo } from "react";
import { ManagementApi } from "../../services/management/management-api.ts";
import { BrowserChannelConnection } from "../../view-models/channel-connection.ts";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function userBotConnection(userId: string, getToken: (signal: AbortSignal) => Promise<string | null>) {
    const requests = new ManagementApi({ origin: window.location.origin, getToken });
    return new BrowserChannelConnection(userId, window.localStorage, async (botId, signal) => {
        const bots = await requests.listBots(signal);
        if (!bots.some((bot) => bot.botId === botId)) {
            throw new Error("Your Bot is unavailable.");
        }
        return { channelId: botId };
    });
}

export function MobiusManagement() {
    const identity = useActiveIdentity();
    const requests = useMemo(
        () => new ManagementApi({ origin: window.location.origin, getToken: identity.getToken }),
        [identity],
    );
    return <BotChatHome requests={requests} />;
}
