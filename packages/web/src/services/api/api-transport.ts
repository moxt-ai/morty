export interface ApiTransport {
    readonly open: () => void;
    readonly fetch: (request: Request) => Promise<Response>;
    readonly measureMobiusLatency: (origin: string, signal: AbortSignal) => Promise<number>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly subscribe: (request: Request, receive: (data: string) => void) => Promise<void>;
    readonly waitForChange: (request: Request) => Promise<void>;
    /** Drops the current connection; the transport reconnects on its own. */
    readonly disconnect: () => void;
    /** Releases the bridge for good and stops reconnecting. */
    readonly dispose: () => void;
}
