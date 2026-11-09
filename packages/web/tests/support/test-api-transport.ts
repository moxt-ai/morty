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
    readonly disconnect = () => this.#current.dispose();
    readonly dispose = this.disconnect;
    readonly fetch: HttpApiTransport["fetch"] = (request) => this.#current.fetch(request);
    readonly measureRelayLatency: HttpApiTransport["measureRelayLatency"] = (origin, signal) =>
        this.#current.measureRelayLatency(origin, signal);
    readonly measureMortyLatency: HttpApiTransport["measureMortyLatency"] = (signal) =>
        this.#current.measureMortyLatency(signal);
    readonly waitForChange: HttpApiTransport["waitForChange"] = async (request, ready) => {
        try {
            await this.#current.waitForChange(request, ready);
        } catch (cause) {
            request.signal.throwIfAborted();
            throw new ApiConnectionError("Network disconnected.", { cause });
        }
    };
}
