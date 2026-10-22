import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "../components/ui/toast.tsx";
import type { WebSocketApiTransport } from "../services/api/websocket-api-transport.ts";
import type { Clock } from "../services/time/clock.ts";
import { createMortyApplication, type MortyApplication } from "../view-models/morty-application.ts";
import { Page } from "./application/app.tsx";
import { MortyApplicationProvider } from "./application/application-context.tsx";
import { createSignedInRouter, SessionApplication } from "./authentication/session-application.tsx";
import { BugReportButton, BugReportDialogHost } from "./diagnostics/bug-report-button.tsx";

/**
 * The one application assembly shared by production and tests: creates the
 * application, builds the continuation router once, and renders the session
 * application tree with its toast host and error boundary. `assembleMorty`
 * owns creation; `mountMorty` additionally attaches a real React root, which
 * is what the page does.
 */
export function assembleMorty(options: {
    readonly transport: WebSocketApiTransport;
    readonly origin: string;
    readonly clock?: Clock;
}): {
    readonly application: MortyApplication;
    readonly element: React.ReactElement;
} {
    // Application-scoped workflows — the Chat API transport and the anonymous
    // identity session — are owned outside React's mount and unmount cycle.
    // They start with the page and end with it, so no component effect
    // manages them.
    const application = createMortyApplication({
        origin: options.origin,
        transport: options.transport,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    // The signed-in router is assembled once with the application: its inputs
    // (the stable authorize action, the application) are fixed for the
    // application's lifetime, so no component rebuilds it while rendering.
    const signedInRouter = createSignedInRouter(application);
    const element = (
        <MortyApplicationProvider application={application}>
            <ToastProvider>
                <ErrorBoundary
                    fallback={
                        <Page>
                            <p role="alert">Morty encountered an error. Please reload to try again.</p>
                            <BugReportButton dialog={application.bugReportDialog} />
                            <BugReportDialogHost dialog={application.bugReportDialog} />
                        </Page>
                    }
                >
                    <SessionApplication application={application} signedInRouter={signedInRouter} />
                </ErrorBoundary>
            </ToastProvider>
        </MortyApplicationProvider>
    );
    return { application, element };
}

/**
 * Attaches the assembled application to a real React root, exactly like the
 * production page. Tests render the assembled element through their own
 * renderer instead and share every other step of the assembly.
 */
export function mountMorty(options: {
    readonly element: HTMLElement;
    readonly transport: WebSocketApiTransport;
    readonly origin: string;
}): {
    readonly application: MortyApplication;
    /** Unmounts the React tree; the application keeps running. */
    readonly unmount: () => void;
    /** Releases the application's resources after its last unmount. */
    readonly dispose: () => void;
} {
    const { application, element } = assembleMorty({ origin: options.origin, transport: options.transport });
    const root = createRoot(options.element, {
        onUncaughtError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
        onRecoverableError: (error, info) =>
            reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
    });
    root.render(element);
    return {
        application,
        unmount: () => {
            void root.unmount();
        },
        dispose: () => {
            application.dispose();
        },
    };
}
