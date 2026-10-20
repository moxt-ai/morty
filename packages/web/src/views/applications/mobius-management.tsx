import { useCallback } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { useMortyApplication } from "../application/application-context.tsx";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function MobiusManagement() {
    const transport = useApiTransport();
    const application = useMortyApplication();
    const identity = useActiveIdentity();
    // The workspace and its chat API are owned by the application factory, so
    // view remounts re-render the same stores and no mount effect manages
    // their loading lifetime.
    const workspace = application.chatWorkspace({
        botId: identity.botId,
        getToken: identity.getToken,
        projectId: identity.projectId,
    });
    const requests = workspace.requests;
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
            workspace={workspace}
            requests={requests}
            createTransfer={createTransfer}
            currentAccessToken={currentAccessToken}
            endRemoteAccess={endRemoteAccess}
            projectId={identity.projectId}
        />
    );
}
