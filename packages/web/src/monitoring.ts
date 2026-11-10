import * as v from "valibot";
import { recordBrowserError } from "./services/diagnostics/browser-diagnostics.ts";
import { initializeBrowserMonitoring } from "./services/diagnostics/sentry-monitoring.ts";

const configuration = v.parse(
    v.object({
        VITE_SENTRY_DSN: v.optional(v.string(), ""),
        VITE_SENTRY_ENVIRONMENT: v.optional(v.picklist(["development", "staging", "production"]), "development"),
        VITE_SENTRY_ORIGIN: v.optional(v.string(), ""),
        VITE_SENTRY_RELEASE: v.optional(v.string(), "morty@development"),
    }),
    import.meta.env,
);
if (
    configuration.VITE_SENTRY_DSN.length > 0 &&
    (configuration.VITE_SENTRY_ORIGIN === "" || configuration.VITE_SENTRY_ORIGIN === window.location.origin)
) {
    initializeBrowserMonitoring({
        dsn: configuration.VITE_SENTRY_DSN,
        environment: configuration.VITE_SENTRY_ENVIRONMENT,
        release: configuration.VITE_SENTRY_RELEASE,
    });
}

window.addEventListener("error", () => recordBrowserError("uncaught_error"));
window.addEventListener("unhandledrejection", () => recordBrowserError("unhandled_rejection"));
