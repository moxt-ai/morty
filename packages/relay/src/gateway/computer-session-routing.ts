import { computerRequestTarget } from "@morty-build/client/relay";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { RelayRelayBindings, RuntimeExecutionBindings } from "../relay-worker.ts";

export { computerRequestTarget };

export async function routeComputerSessionRequest(
    request: Request,
    environment: RelayRelayBindings | RuntimeExecutionBindings,
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
    const computer = environment.COMPUTER_RELAY.getByName(target.computerId, placement);
    return computer.fetch(request);
}
