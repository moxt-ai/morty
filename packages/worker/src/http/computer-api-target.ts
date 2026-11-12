import { isIdentifier, MORTY_API_PREFIX } from "@morty-build/client/protocol";

/** Unverified claims bind an envelope to its Computer; the application router still matches and authorizes it. */
export function computerIdFromApiPath(request: Request): string | null {
    const path = new URL(request.url).pathname;
    const prefix = `${MORTY_API_PREFIX}/`;
    if (!path.startsWith(prefix)) {
        return null;
    }
    const parts = path.slice(prefix.length).split("/");
    const computerIndex = parts[0] === "computers" ? 1 : parts[0] === "chat" && parts[1] === "computers" ? 2 : null;
    if (computerIndex === null) {
        return null;
    }
    // Agent setup remains an HTTP-only CLI operation.
    if (computerIndex === 2 && parts.length === 4 && parts[3] === "setup") {
        return null;
    }
    const computerId = parts[computerIndex];
    if (!isIdentifier(computerId) || parts.length <= computerIndex + 1) {
        return null;
    }
    return computerId;
}

/** Validate the untrusted wire path against the connection's Computer before dispatching to its authorizing router. */
export function matchesComputerApiTarget(request: Request, computerId: string): boolean {
    const path = new URL(request.url).pathname;
    const sessionPrefix = `${MORTY_API_PREFIX}/v1/computers/${encodeURIComponent(computerId)}/harnesses/`;
    if (!path.startsWith(sessionPrefix)) {
        return computerIdFromApiPath(request) === computerId;
    }
    const parts = path.slice(sessionPrefix.length).split("/");
    return (
        parts[1] === "sessions" &&
        parts.length >= 4 &&
        parts[3] !== "access-credentials" &&
        /^Bearer [^\s]+$/u.test(request.headers.get("authorization") ?? "")
    );
}
