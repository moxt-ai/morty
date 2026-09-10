export class MobiusFetchGateway {
    readonly #baseUrl: string;

    constructor(cx: { readonly config: { readonly mobiusBaseUrl: string } }) {
        const { mobiusBaseUrl: baseUrl } = cx.config;
        this.#baseUrl = new URL(baseUrl).toString();
    }

    readonly fetch = async (path: string, init?: RequestInit): Promise<Response> =>
        await fetch(new URL(path, this.#baseUrl), init);
}
