import { isIdentifier, MORTY_API_PREFIX } from "@morty-build/client/protocol";

/** Unverified claims select a destination only. The destination authorizes the complete request. */
export function computerRequestTarget(
    request: Request,
):
    | { readonly computerId: string; readonly kind: "transport" }
    | { readonly computerId: string; readonly kind: "operation" }
    | null {
    const url = new URL(request.url);
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
    if (parts[1] === "daemon" && parts.length > 2) {
        return { computerId, kind: "operation" };
    }
    if (parts[1] !== "sessions" || parts.length < 4 || parts[3] === "access-credentials") {
        return null;
    }
    const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
    if (credential === undefined) {
        return null;
    }
    return { computerId, kind: "operation" };
}
