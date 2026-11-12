import type { MortyEndpointCall } from "./session-endpoints.ts";

export interface MortyTransportCall {
    readonly endpoint: MortyEndpointCall;
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array | null;
    readonly signal: AbortSignal;
}

export interface MortyHttpTransport {
    readonly fetch: (call: MortyTransportCall) => Promise<Response>;
}

export interface MortyTransportSessionEvent {
    readonly data: string;
    readonly eventId: string;
    readonly seqId: number;
}

export class HttpTransport implements MortyHttpTransport {
    readonly fetch = async (call: MortyTransportCall): Promise<Response> =>
        await globalThis.fetch(new URL(call.endpoint.path, call.origin), {
            method: call.endpoint.method,
            headers: call.headers,
            body: call.body instanceof Uint8Array ? call.body.slice().buffer : call.body,
            signal: call.signal,
        });
}
