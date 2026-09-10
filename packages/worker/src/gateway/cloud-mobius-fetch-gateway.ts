import { MobiusFetchGateway } from "../components/slack/infra/mobius-fetch-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";
import { MobiusHttpGateway } from "./mobius-http-gateway.ts";

export class CloudMobiusFetchGateway extends MobiusFetchGateway {
    readonly #gateway: MobiusHttpGateway;
    constructor(cx: { readonly config: { readonly mobiusBaseUrl: string; readonly bindings: CloudBindings } }) {
        super(cx);
        this.#gateway = new MobiusHttpGateway(cx.config.mobiusBaseUrl, cx.config.bindings.APP_ORIGIN);
    }
    override readonly fetch = async (path: string, init?: RequestInit): Promise<Response> => {
        if (!path.startsWith("/mobius/api/") || path.startsWith("//")) {
            return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
        }
        return await this.#gateway.fetch(new Request(new URL(path, "https://cloud.internal"), init));
    };
}
