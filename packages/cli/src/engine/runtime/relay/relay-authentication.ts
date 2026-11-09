import { RUNTIME_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import type { HeldRuntimeCredentials } from "../connection/runtime-credentials.ts";

/**
 * Presents the Runtime's credentials: the current one, and the saved successor a connection makes current as the
 * Relay accepts it.
 */
export function relayCredentialHeaders(credentials: HeldRuntimeCredentials): Readonly<Record<string, string>> {
    return {
        authorization: `Bearer ${credentials.current}`,
        ...(credentials.successor === null ? {} : { [RUNTIME_SUCCESSOR_CREDENTIAL_HEADER]: credentials.successor }),
    };
}

export function relayHttpEndpoint(relayUrl: URL): URL {
    const endpoint = new URL(relayUrl);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.search = "";
    return endpoint;
}
