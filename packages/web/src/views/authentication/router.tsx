import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError, Spinner } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createContinueStore } from "../../view-models/authentication/continue-store.ts";

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
        <div className="grid min-h-dvh place-items-center bg-background px-4 py-8 font-sans text-foreground sm:px-6 sm:py-10">
            <section className="w-full max-w-xl min-w-0 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                {state.kind === "session-opening" ? (
                    <>
                        <h1 className="text-2xl font-semibold">Continue native session</h1>
                        <p className="mt-3 leading-7 text-muted-foreground">Opening the original session in Morty.</p>
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
                        <Button className="mt-6" onClick={retry}>
                            Try again
                        </Button>
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
                    </>
                )}
            </section>
        </div>
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
