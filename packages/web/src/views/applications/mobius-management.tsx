import { useCallback, useEffect, useMemo } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function MobiusManagement() {
    const transport = useApiTransport();
    const identity = useActiveIdentity();
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
    return (
        <BotChatHome
            requests={requests}
            createTransfer={createTransfer}
            currentAccessToken={currentAccessToken}
            endRemoteAccess={endRemoteAccess}
            botId={identity.botId}
            projectId={identity.projectId}
        />
    );
}
