import * as v from "valibot";

export interface PageAnalytics {
    readonly trackPageView: (pathname: string) => void;
}

const configurationSchema = v.object({
    VITE_GA_MEASUREMENT_ID: v.optional(v.union([v.literal(""), v.pipe(v.string(), v.regex(/^G-[A-Z0-9]+$/u))]), ""),
});

function dataLayerFor(target: Window): unknown[] {
    const current: unknown = Reflect.get(target, "dataLayer");
    if (Array.isArray(current)) {
        return current;
    }
    const created: unknown[] = [];
    Reflect.set(target, "dataLayer", created);
    return created;
}

function privatePath(pathname: string, origin: string): string {
    const resolved = new URL(pathname, origin);
    return resolved.origin === origin ? resolved.pathname : "/";
}

export function createGoogleAnalytics(options: {
    readonly document: Document;
    readonly location: Pick<Location, "origin">;
    readonly measurementId: string;
    readonly window: Window;
}): PageAnalytics {
    const measurementId = v.parse(v.pipe(v.string(), v.regex(/^G-[A-Z0-9]+$/u)), options.measurementId);
    const dataLayer = dataLayerFor(options.window);
    const script = options.document.createElement("script");
    script.async = true;
    script.dataset["mortyAnalytics"] = "google";
    script.referrerPolicy = "origin";
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    options.document.head.appendChild(script);

    function gtag(...command: unknown[]): void {
        dataLayer.push(command);
    }
    Reflect.set(options.window, "gtag", gtag);
    gtag("js", new Date());

    let lastPathname: string | null = null;
    return {
        trackPageView: (pathname) => {
            const path = privatePath(pathname, options.location.origin);
            if (path === lastPathname) {
                return;
            }
            lastPathname = path;
            gtag("config", measurementId, {
                page_location: `${options.location.origin}${path}`,
                page_path: path,
                page_title: "Morty",
                send_page_view: false,
            });
            gtag("event", "page_view", {
                page_location: `${options.location.origin}${path}`,
                page_path: path,
                page_title: "Morty",
            });
        },
    };
}

export function createConfiguredGoogleAnalytics(): PageAnalytics | null {
    const configuration = v.parse(configurationSchema, import.meta.env);
    if (configuration.VITE_GA_MEASUREMENT_ID.length === 0) {
        return null;
    }
    return createGoogleAnalytics({
        document,
        location: window.location,
        measurementId: configuration.VITE_GA_MEASUREMENT_ID,
        window,
    });
}
