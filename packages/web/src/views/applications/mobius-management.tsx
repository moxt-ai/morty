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
    const currentUserToken = useCallback(
        async (signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            const localIdentity = await api.loadExisting(signal);
            const token =
                localIdentity?.projectId === identity.projectId
                    ? localIdentity.token
                    : identity.kind === "anonymous"
                      ? await identity.getToken(signal)
                      : null;
            if (token === null) {
                throw new Error("The current user token is unavailable.");
            }
            return {
                accessToken: token,
                token: await api.createRecoveryToken(token, identity.projectId, signal),
            };
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
    const replaceCurrentUser = useCallback(
        async (currentAccessToken: string, replacementToken: string, signal: AbortSignal) => {
            const api = new AnonymousIdentityApi({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
            });
            await api.resolveIdentity(replacementToken, signal);
            await api.endRemoteAccess(currentAccessToken, signal);
            signal.throwIfAborted();
            const replacement = await api.resolveIdentity(replacementToken, signal);
            api.saveIdentity(replacement);
            window.location.reload();
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
            currentUserToken={currentUserToken}
            endRemoteAccess={endRemoteAccess}
            replaceCurrentUser={replaceCurrentUser}
            projectId={identity.projectId}
            selectedBotPreference={selectedBotPreference}
            {...(identity.kind === "anonymous" ? { replaceWorkspace } : {})}
        />
    );
}
