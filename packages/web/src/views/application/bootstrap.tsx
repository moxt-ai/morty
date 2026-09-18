import { ClerkProvider } from "@clerk/react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { reportApplicationError } from "../../index.ts";
import { ApiTransportProvider } from "../../services/api/api-transport-context.tsx";
import { WebSocketApiTransport } from "../../services/api/websocket-api-transport.ts";
import { createBootstrapStore } from "../../view-models/authentication/bootstrap-store.ts";
import { router as authRouter } from "../authentication/router.tsx";
import { SessionApplication } from "../authentication/session-application.tsx";
import { App } from "./app.tsx";

export function Bootstrap() {
    const [transport] = useState(() => new WebSocketApiTransport(window.location.origin));
    const [store] = useState(() =>
        createBootstrapStore(transport.fetch, (error) => reportApplicationError(error, "authentication-bootstrap")),
    );
    const { load, state } = useStore(store);
    useEffect(() => () => transport.close(), [transport]);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    const content =
        state.kind === "loading" ? (
            <App state={{ kind: "loading" }} />
        ) : state.kind === "failed" ? (
            <App state={{ kind: "failed" }} />
        ) : (
            <ClerkProvider
                publishableKey={state.publishableKey}
                signInUrl="/login"
                signUpUrl="/register"
                signInFallbackRedirectUrl="/"
                signUpFallbackRedirectUrl="/"
                routerPush={(to) => {
                    if (to === "/") {
                        window.location.assign(to);
                    } else {
                        authRouter.history.push(to);
                    }
                }}
                routerReplace={(to) => {
                    if (to === "/") {
                        window.location.replace(to);
                    } else {
                        authRouter.history.replace(to);
                    }
                }}
            >
                <SessionApplication />
            </ClerkProvider>
        );
    return <ApiTransportProvider transport={transport}>{content}</ApiTransportProvider>;
}
