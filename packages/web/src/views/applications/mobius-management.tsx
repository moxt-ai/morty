import { useCallback, useEffect, useMemo } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createSelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { DataRegion } from "../../services/identity/anonymous-identity-api.ts";
import { AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
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
            throw new Error("Your Machine is unavailable.");
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
                subscribe: transport.subscribe,
                waitForChange: transport.waitForChange,
            }),
        [identity, transport],
    );
    useEffect(() => () => requests.close(), [requests]);
    const createTransfer = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            const localIdentity = await api.loadExisting(signal);
            if (localIdentity === null || localIdentity.projectId !== identity.projectId) {
                throw new Error("Morty cannot be shared from this device.");
            }
            return await api.createTransfer(localIdentity.token, signal);
        },
        [identity.projectId, transport.fetch],
    );
    const currentAccessToken = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            const localIdentity = await api.loadExisting(signal);
            const token =
                localIdentity?.projectId === identity.projectId ? localIdentity.token : await identity.getToken(signal);
            return token;
        },
        [identity, transport.fetch],
    );
    const endRemoteAccess = useCallback(
        async (token: string, signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            await api.endRemoteAccess(token, signal);
            signal.throwIfAborted();
            window.location.reload();
        },
        [transport.fetch],
    );
    const replaceIdentity = useCallback(
        async (location: DataRegion, signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            await api.replaceIdentity(location, signal);
            signal.throwIfAborted();
            window.location.reload();
        },
        [transport.fetch],
    );
    return (
        <BotChatHome
            requests={requests}
            createTransfer={createTransfer}
            currentAccessToken={currentAccessToken}
            endRemoteAccess={endRemoteAccess}
            replaceIdentity={replaceIdentity}
            projectId={identity.projectId}
            selectedBotPreference={selectedBotPreference}
        />
    );
}
