import { useClerk, useSession } from "@clerk/react";
import { clerkDirectory, createWorkspaceRouter } from "@moxt-ai/mobius-cloud-web-core";
import { MobiusManagement, mobiusWorkspaceConnections } from "@moxt-ai/mobius-cloud-web-core/management";
import { useMemo, useRef } from "react";
import { verifySession } from "../../view-models/authentication/session.ts";
import { App } from "../application/app.tsx";
import { router as authRouter } from "./router.tsx";

function SignedInApplication() {
    const clerk = useClerk();
    const { session } = useSession();
    if (session === null || session === undefined) {
        throw new Error("Missing active session");
    }
    const activeSession = useRef(session);
    activeSession.current = session;
    const sessionId = session.id;
    const userId = session.user.id;
    const workspaceRouter = useMemo(
        () =>
            createWorkspaceRouter(
                clerkDirectory(clerk),
                (signal) => verifySession(sessionId, clerk.session?.id, () => activeSession.current.getToken(), signal),
                MobiusManagement,
                mobiusWorkspaceConnections(userId),
            ),
        [clerk, sessionId, userId],
    );
    return <App state={{ kind: "signed-in", router: workspaceRouter }} />;
}

export function SessionApplication() {
    const { isLoaded, session } = useSession();
    if (!isLoaded) {
        return <App state={{ kind: "loading" }} />;
    }
    const authenticationPath = ["/login", "/register", "/sso-callback"].some((path) =>
        window.location.pathname.startsWith(path),
    );
    if (session === null || session === undefined || authenticationPath) {
        return <App state={{ kind: "authentication", router: authRouter }} />;
    }
    return <SignedInApplication />;
}
