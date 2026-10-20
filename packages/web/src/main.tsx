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
window.addEventListener("pagehide", () => application.dispose());

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
