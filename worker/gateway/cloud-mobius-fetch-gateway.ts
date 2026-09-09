import { MobiusFetchGateway } from "@moxt-ai/app-slack-api/infra";
import { fetchMobiusRequest, isMobiusRequest } from "../di/mobius-application.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";

export class CloudMobiusFetchGateway extends MobiusFetchGateway {
    readonly #baseUrl: string;
    readonly #bindings: CloudBindings;
    constructor(cx: {
        readonly config: {
            readonly mobiusBaseUrl: string;
            readonly bindings: CloudBindings;
        };
    }) {
        super(cx);
        this.#baseUrl = cx.config.mobiusBaseUrl;
        this.#bindings = cx.config.bindings;
    }
    override readonly fetch = async (path: string, init?: RequestInit): Promise<Response> => {
        const configured = new URL(this.#baseUrl);
        const requested = new URL(path, configured);
        if (!path.startsWith("/") || requested.origin !== configured.origin) {
            return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
        }
        const request = new Request(requested, init);
        return isMobiusRequest(requested.pathname)
            ? await fetchMobiusRequest(request, this.#bindings)
            : await fetch(request);
    };
}
