import { useMemo } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createSelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { ManagementApi } from "../../services/management/management-api.ts";
import { BrowserChannelConnection } from "../../view-models/channel-connection.ts";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function userBotConnection(
    userId: string,
    projectId: string,
    getToken: (signal: AbortSignal) => Promise<string | null>,
    fetchRequest: (request: Request) => Promise<Response>,
) {
    const requests = new ManagementApi({ fetchRequest, origin: window.location.origin, projectId, getToken });
    return new BrowserChannelConnection(userId, async (botId, signal) => {
        const bots = await requests.listBots(signal);
        if (!bots.some((bot) => bot.botId === botId)) {
            throw new Error("Your Bot is unavailable.");
        }
        return { channelId: botId };
    });
}

export function MobiusManagement() {
    const transport = useApiTransport();
    const identity = useActiveIdentity();
    const selectedBotPreference = useMemo(() => createSelectedBotPreference(identity.projectId), [identity.projectId]);
    const requests = useMemo(
        () =>
            new BotChatApi({
                origin: window.location.origin,
                projectId: identity.projectId,
                getToken: identity.getToken,
                fetchRequest: transport.fetch,
                waitForChange: transport.waitForChange,
            }),
        [identity, transport],
    );
    return <BotChatHome requests={requests} selectedBotPreference={selectedBotPreference} />;
}
