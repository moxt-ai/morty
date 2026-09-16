import { useCallback, useMemo } from "react";
import { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { ManagementApi } from "../../services/management/management-api.ts";
import { BrowserChannelConnection } from "../../view-models/channel-connection.ts";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function userBotConnection(
    userId: string,
    projectId: string,
    getToken: (signal: AbortSignal) => Promise<string | null>,
) {
    const requests = new ManagementApi({ origin: window.location.origin, projectId, getToken });
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
        () =>
            new BotChatApi({
                origin: window.location.origin,
                projectId: identity.projectId,
                getToken: identity.getToken,
            }),
        [identity],
    );
    const createTransfer = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage });
            const localIdentity = await api.loadExisting(signal);
            if (localIdentity === null || localIdentity.projectId !== identity.projectId) {
                throw new Error("This workspace cannot be shared from this device.");
            }
            return await api.createTransfer(localIdentity.token, signal);
        },
        [identity.projectId],
    );
    return <BotChatHome requests={requests} createTransfer={createTransfer} />;
}
