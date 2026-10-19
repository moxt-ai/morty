import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError, Spinner } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { continueCode, continueUrl, createContinueStore } from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";
import { ContinueQrButton, ContinueQrPanel } from "./continue-qr.tsx";

function ContinuePage() {
    const transport = useApiTransport();
    const [store] = useState(() => createContinueStore(transport.fetch));
    const { continueSession, redeem, state } = useStore(store);
    const code = continueCode(state);
    const qrCodeUrl = code === null ? null : continueUrl(code);
    const canOpenSession =
        (state.kind === "session-confirm" || state.kind === "session-redeeming" || state.kind === "session-failed") &&
        state.handoff.importAvailability.kind === "available";
    useEffect(() => () => store.getState().dispose(), [store]);
    useEffect(() => {
        if (state.kind !== "session-redeeming" && state.kind !== "identity-redeeming") {
            return;
        }
        const controller = new AbortController();
        void redeem(controller.signal);
        return () => controller.abort();
    }, [redeem, state.kind]);
    return (
        <Page navigation={qrCodeUrl === null ? undefined : <ContinueQrButton url={qrCodeUrl} />}>
            <div className="mx-auto flex w-full max-w-4xl items-start justify-center gap-8">
                {qrCodeUrl === null ? null : <ContinueQrPanel url={qrCodeUrl} />}
                <section className="min-w-0 max-w-xl flex-1 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                    <h1 className="text-2xl font-semibold">
                        {state.kind === "session-confirm" ||
                        state.kind === "session-redeeming" ||
                        state.kind === "session-failed"
                            ? "Continue native session"
                            : "Continue in Morty"}
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
                            {state.kind === "session-failed" ? (
                                <p role="alert" className="mt-4 text-sm text-red-700">
                                    {state.message}
                                </p>
                            ) : null}
                            <div className={canOpenSession ? "mt-6 grid gap-3 sm:grid-cols-2" : "mt-6 grid gap-3"}>
                                {canOpenSession ? (
                                    <Button
                                        className="w-full"
                                        disabled={state.kind === "session-redeeming"}
                                        onClick={() => continueSession("import")}
                                    >
                                        Open session
                                        {state.kind === "session-redeeming" && state.choice === "import" ? (
                                            <Spinner label="Opening session" />
                                        ) : null}
                                    </Button>
                                ) : null}
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
                                {canOpenSession
                                    ? "Open continues the original session. Fork creates an independent copy."
                                    : "Fork creates an independent copy."}
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
                    ) : state.kind === "identity-redeeming" ? (
                        <p
                            role="status"
                            aria-label="Securely transferring Morty access"
                            className="mt-4 text-muted-foreground"
                        >
                            Securely transferring Morty access…
                        </p>
                    ) : (
                        <>
                            <p role="alert" className="mt-4 text-red-700">
                                {state.kind === "failed" ? state.message : "This transfer link is invalid."}
                            </p>
                            <Button asChild variant="ghost" className="mt-5">
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
