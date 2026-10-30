export type HomeScreenPlatform = "ios" | "android" | "other";

/**
 * A separate document prepares the address the browser will bookmark. Consume
 * the marker before identity restoration can turn / into a conversation URL.
 * Nothing persists this mode: a fresh visit to / uses normal identity recovery.
 */
export function prepareHomeScreenGuide(): HomeScreenPlatform | null {
    if (window.location.pathname !== "/" || new URLSearchParams(window.location.search).get("view") !== "home-screen") {
        return null;
    }
    window.history.replaceState(null, "", "/");
    document.title = "Morty";

    // Device detection only selects instructions; it does not assert that an
    // installation API is available or that a shortcut has been created.
    if (
        /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    ) {
        return "ios";
    }
    return /Android/u.test(navigator.userAgent) ? "android" : "other";
}
