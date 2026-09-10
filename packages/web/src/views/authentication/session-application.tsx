import { useSession } from "@clerk/react";
import { useMemo, useRef } from "react";
import { createApplicationRouter } from "../../index.ts";
import { verifySession, waitForClerk } from "../../view-models/authentication/session.ts";
import { App, FullScreenApplicationPage, SignedInPage } from "../application/app.tsx";
import { MobiusManagement, userBotConnection } from "../applications/mobius-management.tsx";
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
                userBotConnection(userId, (signal) => waitForClerk(() => activeSession.current.getToken(), signal)),
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
