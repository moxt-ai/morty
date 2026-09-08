import { ClerkProvider } from "@clerk/react";
import { reportApplicationError } from "@moxt-ai/mobius-cloud-web-core";
import { useEffect, useState } from "react";
import { getPublicConfig } from "../../view-models/authentication/config.ts";
import { router as authRouter } from "../authentication/router.tsx";
import { SessionApplication } from "../authentication/session-application.tsx";
import { App } from "./app.tsx";

type BootstrapState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly publishableKey: string }
    | { readonly kind: "failed" };

export function Bootstrap() {
    const [state, setState] = useState<BootstrapState>({ kind: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        void getPublicConfig(controller.signal).then(
            ({ publishableKey }) => {
                if (!controller.signal.aborted) {
                    setState({ kind: "ready", publishableKey });
                }
            },
            (error: unknown) => {
                if (!controller.signal.aborted) {
                    reportApplicationError(error, "authentication-bootstrap");
                    setState({ kind: "failed" });
                }
            },
        );
        return () => controller.abort();
    }, []);
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
