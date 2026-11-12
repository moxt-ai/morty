import type { WsTransport } from "@morty-build/client";

export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiTransport {
    /** Application-owned; callers release their requests/subscriptions, never this connection. */
    readonly computerTransport: (computerId: string) => WsTransport;
    readonly fetch: (request: Request) => Promise<Response>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly waitForChange: (request: Request, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    readonly dispose: () => void;
}
