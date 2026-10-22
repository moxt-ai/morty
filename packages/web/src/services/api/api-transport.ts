export interface ApiTransport {
    readonly open: () => void;
    readonly fetch: (request: Request) => Promise<Response>;
    readonly measureMobiusLatency: (origin: string, signal: AbortSignal) => Promise<number>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
    readonly waitForChange: (request: Request) => Promise<void>;
    /** Resolves once the bridge is connected again, so a failed call can resume. */
    readonly waitForBridge: (signal: AbortSignal) => Promise<void>;
    /** Drops the current connection; the transport reconnects on its own. */
    readonly disconnect: () => void;
    /** Releases the bridge for good and stops reconnecting. */
    readonly dispose: () => void;
}
