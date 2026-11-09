export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiTransport {
    readonly fetch: (request: Request) => Promise<Response>;
    readonly measureRelayLatency: (origin: string, signal: AbortSignal) => Promise<number>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly waitForChange: (request: Request, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    readonly dispose: () => void;
}
