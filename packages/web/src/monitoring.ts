import { breadcrumbsIntegration, browserTracingIntegration, type Event, init } from "@sentry/react";
import * as v from "valibot";
import { recordBrowserError } from "./services/diagnostics/browser-diagnostics.ts";

function withoutQuery(value: string): string {
    try {
        const url = new URL(value, window.location.origin);
        return `${url.origin}${url.pathname}`;
    } catch {
        return "[invalid URL]";
    }
}

function sanitizeEvent<T extends Event>(event: T): T {
    delete event.user;
    if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
        delete event.request.query_string;
        if (event.request.url) {
            event.request.url = withoutQuery(event.request.url);
        }
    }
    return event;
}

const configuration = v.parse(
    v.object({
        VITE_SENTRY_DSN: v.optional(v.string(), ""),
        VITE_SENTRY_ENVIRONMENT: v.optional(v.picklist(["development", "staging", "production"]), "development"),
        VITE_SENTRY_RELEASE: v.optional(v.string(), "morty@development"),
    }),
    import.meta.env,
);
if (configuration.VITE_SENTRY_DSN.length > 0) {
    init({
        dsn: configuration.VITE_SENTRY_DSN,
        environment: configuration.VITE_SENTRY_ENVIRONMENT,
        release: configuration.VITE_SENTRY_RELEASE,
        // Collect nothing about the user, their requests or their queries beyond what the hooks below keep.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            mcp: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
        },
        // Console output and DOM interactions are not recorded as breadcrumbs.
        integrations: (defaults) => [
            ...defaults.filter((integration) => integration.name !== "Console" && integration.name !== "Breadcrumbs"),
            breadcrumbsIntegration({ dom: false }),
            browserTracingIntegration({
                beforeStartSpan: (options) => ({ ...options, name: window.location.pathname }),
            }),
        ],
        tracesSampleRate: configuration.VITE_SENTRY_ENVIRONMENT === "production" ? 0.1 : 1,
        tracePropagationTargets: [],
        beforeBreadcrumb: (breadcrumb) => {
            if (breadcrumb.data) {
                for (const key of ["url", "from", "to"]) {
                    const value: unknown = breadcrumb.data[key];
                    if (typeof value === "string") {
                        breadcrumb.data[key] = withoutQuery(value);
                    }
                }
            }
            return breadcrumb;
        },
        beforeSend: sanitizeEvent,
        beforeSendSpan: (span) => {
            for (const key of ["url.full", "http.url"]) {
                const value = span.attributes[key];
                if (typeof value === "string") {
                    span.attributes[key] = withoutQuery(value);
                }
            }
            const operation = span.attributes["sentry.op"];
            if (/^https?:\/\//u.test(span.name)) {
                span.name = withoutQuery(span.name);
            } else if (typeof operation === "string" && operation.startsWith("http")) {
                const parts = span.name.split(" ", 2);
                span.name =
                    parts.length === 2 ? `${parts[0]} ${withoutQuery(parts[1] ?? "")}` : withoutQuery(span.name);
            }
            return span;
        },
    });
}

window.addEventListener("error", () => recordBrowserError("uncaught_error"));
window.addEventListener("unhandledrejection", () => recordBrowserError("unhandled_rejection"));
