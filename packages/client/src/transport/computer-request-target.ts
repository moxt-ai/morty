import { isIdentifier, MORTY_API_PREFIX } from "@morty-build/client/protocol";

/** Unverified claims select a destination only. The destination authorizes the complete request. */
export function computerRequestTarget(
    request: Request,
):
    | { readonly computerId: string; readonly kind: "transport" }
    | { readonly computerId: string; readonly kind: "operation" }
    | { readonly computerId: string; readonly kind: "computer-api" }
    | null {
    const url = new URL(request.url);
    const apiPrefix = `${MORTY_API_PREFIX}/`;
    if (url.pathname.startsWith(apiPrefix)) {
        const parts = url.pathname.slice(apiPrefix.length).split("/");
        const index = parts[0] === "computers" ? 1 : parts[0] === "chat" && parts[1] === "computers" ? 2 : null;
        if (index !== null) {
            // Agent setup is a CLI HTTPS operation, not a browser Computer API.
            if (index === 2 && parts.length === 4 && parts[3] === "setup") {
                return null;
            }
            const computerId = parts[index];
            return isIdentifier(computerId) && parts.length > index + 1 ? { computerId, kind: "computer-api" } : null;
        }
    }
    const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
    if (!url.pathname.startsWith(prefix)) {
        return null;
    }
    const parts = url.pathname.slice(prefix.length).split("/");
    const computerId = parts[0];
    if (!isIdentifier(computerId)) {
        return null;
    }
    if (parts.length === 2 && parts[1] === "transport") {
        return { computerId, kind: "transport" };
    }
    if (parts[1] !== "harnesses" || parts[3] !== "sessions" || parts.length < 6 || parts[5] === "access-credentials") {
        return null;
    }
    const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
    if (credential === undefined) {
        return null;
    }
    return { computerId, kind: "operation" };
}
