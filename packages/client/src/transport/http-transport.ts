export interface MortyHttpTransport {
    readonly fetch: (request: Request) => Promise<Response>;
}

export interface MortyTransportSessionEvent {
    readonly data: string;
    readonly eventId: string;
    readonly seqId: number;
}

export interface MortyLiveEventTransport {
    readonly openSessionLiveEvents: (request: Request) => Promise<ReadableStream<MortyTransportSessionEvent>>;
}

export function isMortyLiveEventTransport(
    transport: MortyHttpTransport,
): transport is MortyHttpTransport & MortyLiveEventTransport {
    return "openSessionLiveEvents" in transport && typeof transport.openSessionLiveEvents === "function";
}

export class HttpTransport implements MortyHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}
