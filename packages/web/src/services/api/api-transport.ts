import type { WsTransport } from "@morty-build/client";

export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiEndpoint {
    readonly target: { readonly kind: "worker" } | { readonly kind: "computer"; readonly computerId: string };
    readonly url: URL;
    readonly method: "GET" | "POST" | "DELETE";
    readonly operation: string;
    readonly watch: "snapshot" | "none";
}

export interface ApiCall {
    readonly endpoint: ApiEndpoint;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | null;
    readonly signal: AbortSignal;
    readonly redirect?: RequestRedirect;
}

export interface ApiTransport {
    /** Application-owned; callers release their requests/subscriptions, never this connection. */
    readonly computerTransport: (computerId: string) => WsTransport;
    readonly fetch: (call: ApiCall) => Promise<Response>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly waitForChange: (call: ApiCall, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    readonly dispose: () => void;
}
