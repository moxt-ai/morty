import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError, Spinner } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createContinueStore } from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";

function ContinuePage() {
    const transport = useApiTransport();
    const [store] = useState(() => createContinueStore(transport.fetch));
    const { redeem, retry, state } = useStore(store);
    useEffect(() => () => store.getState().dispose(), [store]);
    useEffect(() => {
        if (state.kind !== "session-opening" && state.kind !== "identity-redeeming") {
            return;
        }
        const controller = new AbortController();
        void redeem(controller.signal);
        return () => controller.abort();
    }, [redeem, state.kind]);
    return (
        <Page>
            <div className="mx-auto flex w-full max-w-xl items-start justify-center">
                <section className="min-w-0 flex-1 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                    {state.kind === "session-opening" ? (
                        <>
                            <h1 className="text-2xl font-semibold">Continue native session</h1>
                            <p className="mt-3 leading-7 text-muted-foreground">
                                Opening the original session in Morty.
                            </p>
                            <div className="mt-6 flex items-center gap-3">
                                <Spinner label="Opening session" />
                                <span className="text-sm text-muted-foreground">Opening session…</span>
                            </div>
                        </>
                    ) : state.kind === "session-failed" ? (
                        <>
                            <h1 className="text-2xl font-semibold">Continue native session</h1>
                            <p role="alert" className="mt-4 text-red-700">
                                {state.message}
                            </p>
                            <div className="mt-6 flex flex-wrap items-center gap-3">
                                <Button onClick={retry}>Try again</Button>
                                <Button asChild variant="ghost" className="px-0">
                                    <a href="/">Return to Morty</a>
                                </Button>
                            </div>
                        </>
                    ) : state.kind === "identity-redeeming" ? (
                        <>
                            <h1 className="text-2xl font-semibold">Continue in Morty</h1>
                            <p
                                role="status"
                                aria-label="Securely transferring Morty access"
                                className="mt-4 text-muted-foreground"
                            >
                                Securely transferring Morty access…
                            </p>
                        </>
                    ) : (
                        <>
                            <h1 className="text-2xl font-semibold">Continue in Morty</h1>
                            <p role="alert" className="mt-4 text-red-700">
                                {state.kind === "failed" ? state.message : "This transfer link is invalid."}
                            </p>
                            <Button asChild variant="ghost" className="mt-5 px-0">
                                <a href="/">Return to Morty</a>
                            </Button>
                        </>
                    )}
                </section>
            </div>
        </Page>
    );
}

const rootRoute = createRootRoute({ component: Outlet });
const continueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue",
    component: ContinuePage,
});

export const router = createRouter({
    routeTree: rootRoute.addChildren([continueRoute]),
    defaultOnCatch: (error) => reportApplicationError(error, "continuation-route"),
    scrollRestoration: true,
});
