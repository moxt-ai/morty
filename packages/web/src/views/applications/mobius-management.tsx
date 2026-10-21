import { useCallback, useMemo } from "react";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { AnonymousIdentityApi } from "../../services/identity/anonymous-identity-api.ts";
import { createRemoteAccessOperations } from "../../view-models/chat/remote-access-store.ts";
import { useMortyApplication } from "../application/application-context.tsx";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function MobiusManagement() {
    const transport = useApiTransport();
    const application = useMortyApplication();
    const identity = useActiveIdentity();
    // The workspace and its chat API are owned by the application factory.
    // Memoizing on the identity object keeps acquisition pure across renders:
    // the factory's dispose-and-recreate only runs when the active identity
    // actually changes, never as a side effect of a re-render.
    // Constraint: acquisition still happens during render. The application
    // mounts without StrictMode and the active identity object is stable for
    // as long as the anonymous session stays active, so a concurrent render
    // cannot be discarded between an identity change and its commit; if that
    // ever changes, move acquisition to an event/owner scope.
    const workspace = useMemo(
        () =>
            application.chatWorkspace({
                botId: identity.botId,
                getToken: identity.getToken,
                projectId: identity.projectId,
            }),
        [application, identity],
    );
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
    const { currentAccessToken, endRemoteAccess } = useMemo(
        () =>
            createRemoteAccessOperations({
                fetchRequest: transport.fetch,
                origin: window.location.origin,
                identity,
                onEnded: () => window.location.reload(),
            }),
        [identity, transport.fetch],
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
