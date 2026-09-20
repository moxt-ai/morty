import "./monitoring.ts";
import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installMobiusChatDebugBridge } from "./debug-bridge.ts";
import { Page } from "./views/application/app.tsx";
import { Bootstrap } from "./views/application/bootstrap.tsx";
import "./styles.css";

installMobiusChatDebugBridge();

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("Missing application root");
}

createRoot(rootElement, {
    onUncaughtError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
    onRecoverableError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
}).render(
    <StrictMode>
        <ErrorBoundary
            fallback={
                <Page>
                    <p role="alert">Mobius Cloud encountered an error. Please reload to try again.</p>
                </Page>
            }
        >
            <Bootstrap />
        </ErrorBoundary>
    </StrictMode>,
);
