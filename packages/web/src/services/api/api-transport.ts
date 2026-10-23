export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiTransport {
    readonly open: () => void;
    /** Checks a resumed connection and restarts a suspended retry budget. */
    readonly recover: (signal: AbortSignal) => Promise<void>;
    readonly fetch: (request: Request) => Promise<Response>;
    /** Resolves once the bridge is connected again; it never re-issues a request. */
    readonly waitForBridge: (signal: AbortSignal) => Promise<void>;
    readonly measureMobiusLatency: (origin: string, signal: AbortSignal) => Promise<number>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
    readonly waitForChange: (request: Request, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    /** Drops the current connection; the transport reconnects on its own. */
    readonly disconnect: () => void;
    /** Releases the bridge for good and stops reconnecting. */
    readonly dispose: () => void;
}
