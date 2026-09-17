import { ClerkProvider } from "@clerk/react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { reportApplicationError } from "../../index.ts";
import { createBootstrapStore } from "../../view-models/authentication/bootstrap-store.ts";
import { router as authRouter } from "../authentication/router.tsx";
import { SessionApplication } from "../authentication/session-application.tsx";
import { App } from "./app.tsx";

export function Bootstrap() {
    const [store] = useState(() =>
        createBootstrapStore((error) => reportApplicationError(error, "authentication-bootstrap")),
    );
    const { load, state } = useStore(store);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    if (state.kind === "loading") {
        return <App state={{ kind: "loading" }} />;
    }
    if (state.kind === "failed") {
        return <App state={{ kind: "failed" }} />;
    }
    return (
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
}
