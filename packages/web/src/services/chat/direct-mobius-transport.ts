import type { MobiusHttpTransport } from "@moxt-ai/mobius-sdk";

export class DirectMobiusTransport implements MobiusHttpTransport {
    readonly #appId: string;
    constructor(appId: string) {
        if (appId.length === 0 || appId.includes("\r") || appId.includes("\n")) {
            throw new Error("The Mobius application identifier is invalid.");
        }
        this.#appId = appId;
    }
    readonly fetch = async (request: Request): Promise<Response> => {
        const headers = new Headers(request.headers);
        headers.set("x-mobius-app-id", this.#appId);
        return await fetch(new Request(request, { headers }));
    };
}
