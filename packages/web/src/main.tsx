import "./monitoring.ts";
import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/ui/toast.tsx";
import { installMortyDebugBridge } from "./debug-bridge.ts";
import { Page } from "./views/application/app.tsx";
import { Bootstrap } from "./views/application/bootstrap.tsx";
import { BugReportButton } from "./views/diagnostics/bug-report-button.tsx";
import "./styles.css";

installMortyDebugBridge();

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

// React StrictMode intentionally mounts, unmounts, and remounts every component.
// That cycle closes the Chat API transport while the session store is still
// loading, and the remounted load starts before Bootstrap can reopen it, so every
// reload with an existing identity lands on the failure page. The transport's
// close() is terminal by design, so the application root does not use StrictMode.
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
            <Bootstrap />
        </ErrorBoundary>
    </ToastProvider>,
);
