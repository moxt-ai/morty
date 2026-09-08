import { breadcrumbsIntegration, browserTracingIntegration, type Event, init } from "@sentry/react";
import * as v from "valibot";

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
        VITE_SENTRY_RELEASE: v.optional(v.string(), "mobius-cloud@development"),
    }),
    import.meta.env,
);
if (configuration.VITE_SENTRY_DSN.length > 0) {
    init({
        dsn: configuration.VITE_SENTRY_DSN,
        environment: configuration.VITE_SENTRY_ENVIRONMENT,
        release: configuration.VITE_SENTRY_RELEASE,
        sendDefaultPii: false,
        integrations: [
            breadcrumbsIntegration({ console: false, dom: false }),
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
        beforeSendTransaction: sanitizeEvent,
        beforeSendSpan: (span) => {
            for (const key of ["url.full", "http.url"]) {
                const value = span.data[key];
                if (typeof value === "string") {
                    span.data[key] = withoutQuery(value);
                }
            }
            if (span.description && /^https?:\/\//u.test(span.description)) {
                span.description = withoutQuery(span.description);
            } else if (span.description && span.op?.startsWith("http")) {
                const parts = span.description.split(" ", 2);
                span.description =
                    parts.length === 2 ? `${parts[0]} ${withoutQuery(parts[1] ?? "")}` : withoutQuery(span.description);
            }
            return span;
        },
    });
}
