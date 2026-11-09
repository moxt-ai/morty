import { computerRequestTarget } from "@morty-build/client/platform";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { PlatformRelayBindings, RuntimeExecutionBindings } from "../platform-worker.ts";

export { computerRequestTarget };

export async function routeRuntimeSessionRequest(
    request: Request,
    environment: PlatformRelayBindings | RuntimeExecutionBindings,
): Promise<Response | null> {
    if ("MORTY_RUNTIME_EXECUTION" in environment) {
        return null;
    }
    const target = computerRequestTarget(request);
    if (target === null) {
        return null;
    }
    const placement = decodeComputerPlacement(target.computerId);
    if (placement === null) {
        return Response.json(
            { error: { code: "invalid_computer_id", message: "Invalid computer ID" } },
            { status: 400 },
        );
    }
    return environment.COMPUTER_RELAY.getByName(target.computerId, placement).fetch(request);
}
