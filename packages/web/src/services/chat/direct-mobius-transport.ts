import type { MobiusHttpTransport } from "@moxt-ai/mobius-sdk";

export class DirectMobiusTransport implements MobiusHttpTransport {
    readonly #appId: string;
    readonly #streamTransport: MobiusHttpTransport;
    readonly #transport: MobiusHttpTransport;

    constructor(appId: string, transport: MobiusHttpTransport, streamTransport: MobiusHttpTransport) {
        if (appId.length === 0 || appId.includes("\r") || appId.includes("\n")) {
            throw new Error("The Mobius application identifier is invalid.");
        }
        this.#appId = appId;
        this.#transport = transport;
        this.#streamTransport = streamTransport;
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        const headers = new Headers(request.headers);
        headers.set("x-mobius-app-id", this.#appId);
        const transport =
            headers.get("accept")?.startsWith("text/event-stream") === true ? this.#streamTransport : this.#transport;
        return await transport.fetch(new Request(request, { headers }));
    };
}
