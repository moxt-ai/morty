import { AuthenticateWithRedirectCallback, SignIn, SignUp, useUser } from "@clerk/react";
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { Page } from "../application/app.tsx";

const buttonClass =
    "inline-flex min-h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-600";

function LandingPage() {
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm sm:p-10">
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-700">
                    A place for your agents
                </p>
                <h1 className="text-3xl font-semibold leading-tight tracking-tight">Welcome to Mobius Cloud</h1>
                <p className="mt-4 leading-7 text-zinc-600">Sign in to your account, or create one to get started.</p>
                <div className="mt-8 flex flex-wrap gap-3">
                    <Link to="/login" className={`${buttonClass} bg-violet-700 text-white hover:bg-violet-800`}>
                        Sign in
                    </Link>
                    <Link to="/register" className={`${buttonClass} border border-zinc-300 bg-white hover:bg-zinc-50`}>
                        Create account
                    </Link>
                </div>
            </section>
        </Page>
    );
}

function LoginPage({ register = false }: { readonly register?: boolean }) {
    const { isSignedIn } = useUser();
    return (
        <main className="grid min-h-screen md:grid-cols-[minmax(0,1fr)_minmax(420px,0.72fr)]">
            <section className="flex min-h-[38vh] flex-col justify-between gap-18 bg-zinc-950 px-8 py-10 text-white md:min-h-screen md:px-[clamp(2rem,7vw,6.25rem)] md:pb-18">
                <Link className="flex items-center gap-3 font-semibold" to="/">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-violet-500 text-2xl">∞</span>
                    Mobius Cloud
                </Link>
                <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-violet-300">Agent workspace</p>
                    <h1 className="my-4 max-w-3xl text-[clamp(2.5rem,7vw,5.6rem)] font-semibold leading-[0.96] tracking-[-0.06em]">
                        Your team and agents, connected.
                    </h1>
                    <p className="max-w-xl text-lg leading-7 text-zinc-400">
                        Sign in to manage workspaces, conversations, and integrations.
                    </p>
                </div>
            </section>
            <section className="grid place-items-center p-9">
                <div>
                    {isSignedIn ? (
                        <a className={`${buttonClass} bg-violet-700 text-white`} href="/">
                            Continue to workspaces
                        </a>
                    ) : register ? (
                        <SignUp routing="path" path="/register" signInUrl="/login" fallbackRedirectUrl="/" />
                    ) : (
                        <SignIn routing="path" path="/login" signUpUrl="/register" fallbackRedirectUrl="/" />
                    )}
                    <Link className="mt-5 block text-center text-sm font-semibold text-violet-700" to="/">
                        Back to Mobius Cloud
                    </Link>
                </div>
            </section>
        </main>
    );
}

const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: () => (
        <Page>
            <h1 className="text-3xl font-semibold">Page not found</h1>
            <Link className="mt-5 inline-block text-violet-700" to="/">
                Back to Mobius Cloud
            </Link>
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

export const router = createRouter({
    routeTree: rootRoute.addChildren([
        landingRoute,
        loginRoute,
        loginStepRoute,
        registerRoute,
        registerStepRoute,
        callbackRoute,
    ]),
    scrollRestoration: true,
});
