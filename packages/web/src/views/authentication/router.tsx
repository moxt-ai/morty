import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Tooltip } from "radix-ui";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, reportApplicationError, Spinner } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import {
    continueCode,
    continueUrl,
    createContinueStore,
    type NativeSessionImportAvailability,
} from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";
import { ContinueQrButton, ContinueQrPanel } from "./continue-qr.tsx";

function ImportSessionButton({
    importAvailability,
    importing,
    redeeming,
    select,
}: {
    readonly importAvailability: NativeSessionImportAvailability;
    readonly importing: boolean;
    readonly redeeming: boolean;
    readonly select: () => void;
}) {
    const button = (
        <Button className="w-full" disabled={redeeming || importAvailability.kind === "unavailable"} onClick={select}>
            Import session
            {importing ? <Spinner label="Importing session" /> : null}
        </Button>
    );
    if (importAvailability.kind === "available") {
        return button;
    }
    return (
        <Tooltip.Provider delayDuration={150}>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>
                    <fieldset aria-label="Why import is unavailable" className="m-0 min-w-0 rounded-md border-0 p-0">
                        {button}
                    </fieldset>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <Tooltip.Content
                        className="z-50 max-w-72 rounded-md bg-foreground px-3 py-2 text-xs leading-5 text-background shadow-md"
                        sideOffset={6}
                    >
                        {importAvailability.reason}
                        <Tooltip.Arrow className="fill-foreground" />
                    </Tooltip.Content>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    );
}
function ContinuePage() {
    const transport = useApiTransport();
    const [store] = useState(() => createContinueStore(transport.fetch));
    const { continueIdentity, continueSession, redeem, state } = useStore(store);
    const code = continueCode(state);
    const qrCodeUrl = code === null ? null : continueUrl(code);
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
                            {state.replacesIdentity ? (
                                <p className="mt-4 text-sm leading-6 text-amber-700">
                                    Continuing replaces the anonymous Morty identity currently stored on this device.
                                </p>
                            ) : null}
                            {state.kind === "session-failed" ? (
                                <p role="alert" className="mt-4 text-sm text-red-700">
                                    {state.message}
                                </p>
                            ) : null}
                            <div className="mt-6 grid gap-3 sm:grid-cols-2">
                                <ImportSessionButton
                                    importAvailability={state.handoff.importAvailability}
                                    importing={state.kind === "session-redeeming" && state.choice === "import"}
                                    redeeming={state.kind === "session-redeeming"}
                                    select={() => continueSession("import")}
                                />
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
                    ) : state.kind === "identity-confirm" ? (
                        <>
                            <p className="mt-4 leading-7 text-muted-foreground">
                                Continuing replaces the anonymous Morty identity currently stored on this device.
                            </p>
                            <Button className="mt-6" onClick={continueIdentity}>
                                Replace and continue
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
