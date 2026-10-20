import "./monitoring.ts";
import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/ui/toast.tsx";
import { installMortyDebugBridge } from "./debug-bridge.ts";
import { WebSocketApiTransport } from "./services/api/websocket-api-transport.ts";
import { createMortyApplication } from "./view-models/morty-application.ts";
import { Page } from "./views/application/app.tsx";
import { Bootstrap } from "./views/application/bootstrap.tsx";
import { BugReportButton } from "./views/diagnostics/bug-report-button.tsx";
import "./styles.css";

installMortyDebugBridge();

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

// Application-scoped workflows — the Chat API transport and the anonymous
// identity session — are owned outside React's mount and unmount cycle. They
// start with the page and end with it, so no component effect manages them.
const application = createMortyApplication({
    origin: window.location.origin,
    transport: new WebSocketApiTransport(window.location.origin),
});
// The browser may hide the page into the back/forward cache instead of
// discarding it. Disposing there would strand a restored page with a closed
// transport, so only release the application when the page is truly going
// away; a restored page reloads itself below to rebuild live connections.
window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
        application.dispose();
    }
});
window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
        window.location.reload();
    }
});

createRoot(rootElement, {
    onUncaughtError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
    onRecoverableError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
}).render(
    <ToastProvider>
        <ErrorBoundary
            fallback={
                <Page>
                    <p role="alert">Morty encountered an error. Please reload to try again.</p>
                    <BugReportButton />
                </Page>
            }
        >
            <Bootstrap application={application} />
        </ErrorBoundary>
    </ToastProvider>,
);
