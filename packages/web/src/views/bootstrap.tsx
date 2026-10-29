import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { createRoot } from "react-dom/client";
import { ImageDownloadProvider } from "../components/images/image-download.tsx";
import { ImageViewerProvider } from "../components/images/image-gallery.tsx";
import { ToastProvider } from "../components/ui/toast.tsx";
import { installInputModalityTracking } from "../input-modality.ts";
import type { PageAnalytics } from "../services/analytics/google-analytics.ts";
import type { WebSocketApiTransport } from "../services/api/websocket-api-transport.ts";
import type { Clock } from "../services/time/clock.ts";
import { createImageDownloadStore } from "../view-models/chat/image-download-store.ts";
import { createMortyApplication, type MortyApplication } from "../view-models/morty-application.ts";
import { MortyApplicationProvider } from "./application/application-context.tsx";
import { MortyCrashFallback } from "./application/crash-fallback.tsx";
import { createContinuationRouter } from "./authentication/router.tsx";
import { createSignedInRouter, SessionApplication } from "./authentication/session-application.tsx";

/**
 * The one application assembly shared by production and tests: creates the
 * application, builds the continuation router once, and renders the session
 * application tree with its toast host and error boundary. `assembleMorty`
 * owns creation; `mountMorty` additionally attaches a real React root, which
 * is what the page does.
 */
export function assembleMorty(options: {
    readonly analytics?: PageAnalytics | null;
    readonly transport: WebSocketApiTransport;
    readonly origin: string;
    readonly clock?: Clock;
}): {
    readonly application: MortyApplication;
    readonly disposeAnalytics: () => void;
    readonly element: React.ReactElement;
} {
    installInputModalityTracking();
    // Application-scoped workflows — the Chat API transport and the anonymous
    // identity session — are owned outside React's mount and unmount cycle.
    // They start with the page and end with it, so no component effect
    // manages them.
    const application = createMortyApplication({
        origin: options.origin,
        transport: options.transport,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.analytics === undefined ? {} : { analytics: options.analytics }),
    });
    // The signed-in router is assembled once with the application: its inputs
    // (the stable authorize action, the application) are fixed for the
    // application's lifetime, so no component rebuilds it while rendering.
    const signedInRouter = createSignedInRouter(application);
    const continuationRouter = createContinuationRouter();
    const analytics = application.analytics;
    const analyticsSubscriptions =
        analytics === null
            ? []
            : [signedInRouter, continuationRouter].map((router) =>
                  router.subscribe("onRendered", ({ toLocation }) => analytics.trackPageView(toLocation.pathname)),
              );
    const element = (
        <MortyApplicationProvider application={application}>
            <ImageDownloadProvider createStore={createImageDownloadStore}>
                <ToastProvider>
                    <ErrorBoundary fallback={<MortyCrashFallback dialog={application.bugReportDialog} />}>
                        <ImageViewerProvider>
                            <SessionApplication
                                application={application}
                                signedInRouter={signedInRouter}
                                continuationRouter={continuationRouter}
                            />
                        </ImageViewerProvider>
                    </ErrorBoundary>
                </ToastProvider>
            </ImageDownloadProvider>
        </MortyApplicationProvider>
    );
    return {
        application,
        disposeAnalytics: () => {
            for (const unsubscribe of analyticsSubscriptions) {
                unsubscribe();
            }
        },
        element,
    };
}

/**
 * Attaches the assembled application to a real React root, exactly like the
 * production page. Tests render the assembled element through their own
 * renderer instead and share every other step of the assembly.
 */
export function mountMorty(options: {
    readonly analytics?: PageAnalytics | null;
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
    const { application, disposeAnalytics, element } = assembleMorty({
        ...(options.analytics === undefined ? {} : { analytics: options.analytics }),
        origin: options.origin,
        transport: options.transport,
    });
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
            disposeAnalytics();
            application.dispose();
        },
    };
}
