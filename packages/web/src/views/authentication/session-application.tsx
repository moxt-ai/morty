import { useSession } from "@clerk/react";
import { useMemo, useRef } from "react";
import { createApplicationRouter } from "../../cloud/index.ts";
import { MobiusManagement, userBotConnection } from "../../cloud/views/applications/mobius-management.tsx";
import { verifySession } from "../../view-models/authentication/session.ts";
import { App, FullScreenApplicationPage, SignedInPage } from "../application/app.tsx";
import { router as authRouter } from "./router.tsx";

function SignedInApplication() {
    const { session } = useSession();
    if (session === null || session === undefined) {
        throw new Error("Missing active session");
    }
    const activeSession = useRef(session);
    activeSession.current = session;
    const sessionId = session.id;
    const userId = session.user.id;
    const applicationRouter = useMemo(
        () =>
            createApplicationRouter(
                (signal) =>
                    verifySession(sessionId, activeSession.current.id, () => activeSession.current.getToken(), signal),
                userId,
                MobiusManagement,
                userBotConnection(userId),
                { Standard: SignedInPage, Application: FullScreenApplicationPage },
            ),
        [sessionId, userId],
    );
    return <App state={{ kind: "signed-in", router: applicationRouter }} />;
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
