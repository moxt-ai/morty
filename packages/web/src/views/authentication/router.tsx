import { AuthenticateWithRedirectCallback, SignIn, SignUp, useUser } from "@clerk/react";
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError, Spinner } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createContinueStore } from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";

function LandingPage() {
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                <p className="mb-3 text-xs font-medium text-primary">A place for your agents</p>
                <h1 className="text-3xl font-semibold leading-tight tracking-tight">Welcome to Morty</h1>
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
                    Morty
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
                        <Link to="/">Back to Morty</Link>
                    </Button>
                </div>
            </section>
        </main>
    );
}

function ContinuePage() {
    const transport = useApiTransport();
    const [store] = useState(() => createContinueStore(transport.fetch));
    const { continueSession, continueWorkspace, redeem, state } = useStore(store);
    useEffect(() => {
        if (state.kind !== "session-redeeming" && state.kind !== "workspace-redeeming") {
            return;
        }
        const controller = new AbortController();
        void redeem(controller.signal);
        return () => controller.abort();
    }, [redeem, state.kind]);
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                <h1 className="text-2xl font-semibold">
                    {state.kind === "session-confirm" ||
                    state.kind === "session-redeeming" ||
                    state.kind === "session-failed"
                        ? "Continue native session"
                        : "Use this Mobius workspace"}
                </h1>
                {state.kind === "session-confirm" ||
                state.kind === "session-redeeming" ||
                state.kind === "session-failed" ? (
                    <>
                        <p className="mt-3 leading-7 text-muted-foreground">
                            Choose how this native session should open in Mobius.
                        </p>
                        <dl className="mt-5 grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
                            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
                                <dt className="text-muted-foreground">Agent</dt>
                                <dd className="truncate font-medium">{state.handoff.harness}</dd>
                            </div>
                            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
                                <dt className="text-muted-foreground">Session ID</dt>
                                <dd className="break-all font-mono text-xs">{state.handoff.sessionId}</dd>
                            </div>
                        </dl>
                        {state.replacesWorkspace ? (
                            <p className="mt-4 text-sm leading-6 text-amber-700">
                                Continuing replaces the anonymous workspace currently stored on this device.
                            </p>
                        ) : null}
                        {state.kind === "session-failed" ? (
                            <p role="alert" className="mt-4 text-sm text-red-700">
                                {state.message}
                            </p>
                        ) : null}
                        <div className="mt-6 grid gap-3 sm:grid-cols-2">
                            <Button
                                disabled={state.kind === "session-redeeming"}
                                onClick={() => continueSession("import")}
                            >
                                Import session
                                {state.kind === "session-redeeming" && state.choice === "import" ? (
                                    <Spinner label="Importing session" />
                                ) : null}
                            </Button>
                            <Button
                                disabled={state.kind === "session-redeeming"}
                                variant="outline"
                                onClick={() => continueSession("fork")}
                            >
                                Fork session
                                {state.kind === "session-redeeming" && state.choice === "fork" ? (
                                    <Spinner label="Forking session" />
                                ) : null}
                            </Button>
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                            Import continues the original session. Fork creates an independent copy.
                        </p>
                        <Button
                            className="mt-3 px-0"
                            disabled={state.kind === "session-redeeming"}
                            variant="ghost"
                            onClick={() => continueSession("skip")}
                        >
                            Skip
                            {state.kind === "session-redeeming" && state.choice === "skip" ? (
                                <Spinner label="Skipping session" />
                            ) : null}
                        </Button>
                    </>
                ) : state.kind === "workspace-confirm" ? (
                    <>
                        <p className="mt-4 leading-7 text-muted-foreground">
                            Continuing replaces the anonymous workspace currently stored on this device.
                        </p>
                        <Button className="mt-6" onClick={continueWorkspace}>
                            Replace and continue
                        </Button>
                    </>
                ) : state.kind === "workspace-redeeming" ? (
                    <p
                        role="status"
                        aria-label="Securely transferring the workspace"
                        className="mt-4 text-muted-foreground"
                    >
                        Securely transferring the workspace…
                    </p>
                ) : (
                    <>
                        <p role="alert" className="mt-4 text-red-700">
                            {state.kind === "failed" ? state.message : "This transfer link is invalid."}
                        </p>
                        <Button asChild variant="ghost" className="mt-5">
                            <Link to="/">Return to Morty</Link>
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
                <Link to="/">Back to Morty</Link>
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
