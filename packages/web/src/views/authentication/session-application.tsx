import type { AnyRouter } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense } from "react";
import { createApplicationRouter } from "../../index.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { App } from "../application/app.tsx";
import { MobiusManagement } from "../applications/mobius-management.tsx";

const PlaygroundApplication = lazy(() =>
    import("../playground/playground-application.tsx").then((module) => ({
        default: module.PlaygroundApplication,
    })),
);

function isComponentLibraryPath(pathname: string): boolean {
    return pathname === "/playground" || pathname.startsWith("/playground/");
}

export function createSignedInRouter(application: MortyApplication) {
    const authorize = (signal: AbortSignal) => application.anonymousSession.getState().authorize(signal);
    const Standard = ({ children }: { readonly children: ReactNode }) => <>{children}</>;
    return createApplicationRouter(
        authorize,
        ({ view }) => <MobiusManagement application={application} view={view} />,
        { Application: Standard, Standard },
    );
}

export function SessionApplication({
    application,
    signedInRouter,
    continuationRouter,
}: {
    readonly application: MortyApplication;
    readonly signedInRouter: AnyRouter;
    readonly continuationRouter: AnyRouter;
}) {
    const { state } = useExternalStore(application.anonymousSession);
    if (isComponentLibraryPath(window.location.pathname)) {
        return (
            <Suspense
                fallback={
                    <main className="grid min-h-dvh place-items-center bg-background text-14 text-muted-foreground">
                        Loading component library
                    </main>
                }
            >
                <PlaygroundApplication application={application} />
            </Suspense>
        );
    }
    const continuationPath = window.location.pathname.startsWith("/continue");
    if (continuationPath) {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{ kind: "authentication", router: continuationRouter }}
            />
        );
    }
    if (state.kind === "loading") {
        return <App bugReportDialog={application.bugReportDialog} state={{ kind: "loading" }} />;
    }
    if (state.kind === "failed") {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{
                    kind: "failed",
                    retry: application.reloadIdentity,
                    retrying: state.retrying,
                }}
            />
        );
    }
    if (state.kind === "invalid-link") {
        return <App bugReportDialog={application.bugReportDialog} state={state} />;
    }
    // Every branch renders the same App component, so the tree — and the bug
    // report dialog host inside it — survives the loading → setup/active
    // transition without unmounting or cancelling an in-flight send.
    if (state.kind === "setup") {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{ kind: "setup", notice: state.notice, returnHref: state.returnHref }}
            />
        );
    }
    return <App bugReportDialog={application.bugReportDialog} state={{ kind: "signed-in", router: signedInRouter }} />;
}
