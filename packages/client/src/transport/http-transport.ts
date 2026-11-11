export interface MortyHttpTransport {
    readonly fetch: (request: Request) => Promise<Response>;
}

export interface MortyTransportSessionEvent {
    readonly data: string;
    readonly eventId: string;
    readonly seqId: number;
}

export class HttpTransport implements MortyHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}
