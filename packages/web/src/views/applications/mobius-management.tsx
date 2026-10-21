import { useMemo } from "react";
import { useMortyApplication } from "../application/application-context.tsx";
import { useActiveIdentity } from "../authentication/identity-context.tsx";
import { BotChatHome } from "../chat/bot-chat-home.tsx";

export function MobiusManagement() {
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
    const access = useMemo(
        () => application.identityAccess(identity, () => window.location.reload()),
        [application, identity],
    );
    return (
        <BotChatHome
            workspace={workspace}
            requests={requests}
            createTransfer={access.createTransfer}
            currentAccessToken={access.currentAccessToken}
            endRemoteAccess={access.endRemoteAccess}
            projectId={identity.projectId}
        />
    );
}
