import { AuthenticateWithRedirectCallback, SignIn, SignUp, useUser } from "@clerk/react";
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError } from "../../index.ts";
import { createContinueStore } from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";

function LandingPage() {
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                <p className="mb-3 text-xs font-medium text-primary">A place for your agents</p>
                <h1 className="text-3xl font-semibold leading-tight tracking-tight">Welcome to Mobius Cloud</h1>
                <p className="mt-4 leading-7 text-zinc-600">Sign in to your account, or create one to get started.</p>
                <div className="mt-8 flex flex-wrap gap-3">
                    <Button asChild>
                        <Link to="/login">Sign in</Link>
                    </Button>
                    <Button asChild variant="outline">
                        <Link to="/register">Create account</Link>
                    </Button>
                </div>
            </section>
        </Page>
    );
}

function LoginPage({ register = false }: { readonly register?: boolean }) {
    const { isSignedIn } = useUser();
    return (
        <main className="grid min-h-dvh md:grid-cols-[minmax(0,1fr)_minmax(420px,0.72fr)]">
            <section className="flex min-w-0 flex-col justify-between gap-6 bg-zinc-950 px-5 py-5 text-white md:min-h-dvh md:gap-18 md:px-[clamp(2rem,7vw,6.25rem)] md:py-10 md:pb-18">
                <Link className="flex items-center gap-3 font-semibold" to="/">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-2xl">∞</span>
                    Mobius Cloud
                </Link>
                <div>
                    <p className="text-xs font-medium text-emerald-300">Agent workspace</p>
                    <h1 className="my-3 max-w-3xl text-3xl font-semibold leading-tight tracking-tight md:my-4 md:text-[clamp(2.5rem,7vw,5.6rem)] md:leading-[0.96] md:tracking-[-0.06em]">
                        Your team and agents, connected.
                    </h1>
                    <p className="max-w-xl text-sm leading-6 text-zinc-400 md:text-lg md:leading-7">
                        Sign in to manage your bots, conversations, and integrations.
                    </p>
                </div>
            </section>
            <section className="grid min-w-0 place-items-center px-4 py-6 md:p-9">
                <div className="w-full max-w-[400px]">
                    {isSignedIn ? (
                        <Button asChild>
                            <a href="/">Continue to your bots</a>
                        </Button>
                    ) : register ? (
                        <SignUp
                            appearance={{ elements: { rootBox: { width: "100%" }, cardBox: { width: "100%" } } }}
                            routing="path"
                            path="/register"
                            signInUrl="/login"
                            fallbackRedirectUrl="/"
                        />
                    ) : (
                        <SignIn
                            appearance={{ elements: { rootBox: { width: "100%" }, cardBox: { width: "100%" } } }}
                            routing="path"
                            path="/login"
                            signUpUrl="/register"
                            fallbackRedirectUrl="/"
                        />
                    )}
                    <Button asChild variant="ghost" className="mt-5 w-full">
                        <Link to="/">Back to Mobius Cloud</Link>
                    </Button>
                </div>
            </section>
        </main>
    );
}

function ContinuePage() {
    const [store] = useState(createContinueStore);
    const { confirm, redeem, state } = useStore(store);
    useEffect(() => {
        if (state.kind !== "redeeming") {
            return;
        }
        const controller = new AbortController();
        void redeem(controller.signal);
        return () => controller.abort();
    }, [redeem, state.kind]);
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                <h1 className="text-2xl font-semibold">Use this Mobius workspace</h1>
                {state.kind === "confirm" ? (
                    <>
                        <p className="mt-4 leading-7 text-muted-foreground">
                            Continuing replaces the anonymous workspace currently stored on this device.
                        </p>
                        <Button className="mt-6" onClick={confirm}>
                            Replace and continue
                        </Button>
                    </>
                ) : state.kind === "redeeming" ? (
                    <p role="status" className="mt-4 text-muted-foreground">
                        Securely transferring the workspace…
                    </p>
                ) : (
                    <>
                        <p role="alert" className="mt-4 text-red-700">
                            {state.kind === "failed" ? state.message : "This transfer link is invalid."}
                        </p>
                        <Button asChild variant="ghost" className="mt-5">
                            <Link to="/">Return to Mobius Cloud</Link>
                        </Button>
                    </>
                )}
            </section>
        </Page>
    );
}

const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: () => (
        <Page>
            <h1 className="text-3xl font-semibold">Page not found</h1>
            <Button asChild variant="ghost" className="mt-5">
                <Link to="/">Back to Mobius Cloud</Link>
            </Button>
        </Page>
    ),
});
const landingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: LandingPage,
});
const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginPage,
});
const loginStepRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login/$",
    component: LoginPage,
});
const registerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/register",
    component: () => <LoginPage register />,
});
const registerStepRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/register/$",
    component: () => <LoginPage register />,
});
const callbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sso-callback",
    component: () => <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" />,
});
const continueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue",
    component: ContinuePage,
});

export const router = createRouter({
    routeTree: rootRoute.addChildren([
        landingRoute,
        loginRoute,
        loginStepRoute,
        registerRoute,
        registerStepRoute,
        callbackRoute,
        continueRoute,
    ]),
    defaultOnCatch: (error) => reportApplicationError(error, "authentication-route"),
    scrollRestoration: true,
});
