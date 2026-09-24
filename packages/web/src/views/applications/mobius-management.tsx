import { useCallback, useMemo } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createSelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { WorkspaceLocation } from "../../services/identity/anonymous-identity-api.ts";
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
    const createTransfer = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            const localIdentity = await api.loadExisting(signal);
            if (localIdentity === null || localIdentity.projectId !== identity.projectId) {
                throw new Error("This workspace cannot be shared from this device.");
            }
            return await api.createTransfer(localIdentity.token, signal);
        },
        [identity.projectId, transport.fetch],
    );
    const endRemoteAccess = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            const localIdentity = await api.loadExisting(signal);
            if (localIdentity === null) {
                throw new Error("Remote access is no longer available.");
            }
            await api.endRemoteAccess(localIdentity.token, signal);
        },
        [transport.fetch],
    );
    const replaceWorkspace = useCallback(
        async (location: WorkspaceLocation, signal: AbortSignal) => {
            if (identity.kind !== "anonymous") {
                throw new Error("Only a fresh anonymous workspace can change region.");
            }
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            await api.replaceWorkspace(location, signal);
            signal.throwIfAborted();
            window.location.reload();
        },
        [identity.kind, transport.fetch],
    );
    return (
        <BotChatHome
            requests={requests}
            createTransfer={createTransfer}
            endRemoteAccess={endRemoteAccess}
            projectId={identity.projectId}
            selectedBotPreference={selectedBotPreference}
            {...(identity.kind === "anonymous" ? { replaceWorkspace } : {})}
        />
    );
}
