import { ApiConnectionError, HttpApiTransport } from "../../src/services/api/http-api-transport.ts";

export class TestApiTransport {
    readonly #origin: string;
    #current: HttpApiTransport;
    constructor(origin: string) {
        this.#origin = origin;
        this.#current = new HttpApiTransport(origin);
    }
    readonly open = () => {
        this.#current.dispose();
        this.#current = new HttpApiTransport(this.#origin);
    };
    readonly disconnect = () => this.#current.dispose(new ApiConnectionError("Network disconnected."));
    readonly dispose = this.disconnect;
    readonly fetch: HttpApiTransport["fetch"] = (request) => this.#current.fetch(request);
    readonly measureRelayLatency: HttpApiTransport["measureRelayLatency"] = (origin, signal) =>
        this.#current.measureRelayLatency(origin, signal);
    readonly measureMortyLatency: HttpApiTransport["measureMortyLatency"] = (signal) =>
        this.#current.measureMortyLatency(signal);
    readonly waitForChange: HttpApiTransport["waitForChange"] = (request, ready) =>
        this.#current.waitForChange(request, ready);
}
