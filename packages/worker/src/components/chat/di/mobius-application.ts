import { MobiusHttpGateway } from "../../../gateway/mobius-http-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";

export function isMobiusRequest(path: string): boolean {
    return path.startsWith("/mobius/api/");
}

export async function fetchMobiusRequest(request: Request, bindings: CloudBindings): Promise<Response> {
    return await new MobiusHttpGateway(bindings.MOBIUS_BASE_URL).fetch(request);
}
