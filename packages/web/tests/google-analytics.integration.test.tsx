import { afterEach, expect, test } from "vitest";
import { createGoogleAnalytics } from "../src/services/analytics/google-analytics.ts";

afterEach(() => {
    document.head.querySelector('script[data-morty-analytics="google"]')?.remove();
    Reflect.deleteProperty(window, "dataLayer");
    Reflect.deleteProperty(window, "gtag");
    window.history.replaceState(null, "", "/");
});

test("Given a private chat URL, When Morty records page views, Then Google Analytics receives paths without identity, session, or hash data", () => {
    window.history.replaceState(
        null,
        "",
        "/chat?identity=bot_secret~project_secret~user_secret&sessionId=session_secret#transfer-secret",
    );

    const analyticsDocument = document.implementation.createHTMLDocument("Morty");
    const analytics = createGoogleAnalytics({
        document: analyticsDocument,
        location: window.location,
        measurementId: "G-TEST123456",
        window,
    });
    analytics.trackPageView(window.location.pathname);
    analytics.trackPageView(window.location.pathname);

    const script = analyticsDocument.head.querySelector('script[data-morty-analytics="google"]');
    expect(script).toHaveProperty("src", "https://www.googletagmanager.com/gtag/js?id=G-TEST123456");
    expect(script).toHaveProperty("referrerPolicy", "origin");
    const dataLayer: unknown = Reflect.get(window, "dataLayer");
    expect(Array.isArray(dataLayer)).toBe(true);
    const commands = Array.isArray(dataLayer)
        ? dataLayer.map((entry) => {
              const length: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "length") : 0;
              return Array.from({ length: typeof length === "number" ? length : 0 }, (_, index) =>
                  Reflect.get(entry, String(index)),
              );
          })
        : [];
    expect(commands).toEqual([
        ["js", expect.any(Date)],
        [
            "config",
            "G-TEST123456",
            {
                page_location: `${window.location.origin}/chat`,
                page_path: "/chat",
                page_title: "Morty",
                send_page_view: false,
            },
        ],
        [
            "event",
            "page_view",
            {
                page_location: `${window.location.origin}/chat`,
                page_path: "/chat",
                page_title: "Morty",
            },
        ],
    ]);
});
