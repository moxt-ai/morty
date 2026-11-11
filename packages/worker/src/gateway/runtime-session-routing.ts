import { computerRequestTarget } from "@morty-build/client/relay";
import { decodeComputerPlacement } from "../../../relay/src/entity/computer-id.ts";
import type { RelayBindings } from "../composition/relay-bindings.ts";

export async function routeRuntimeSessionRequest(
    request: Request,
    environment: RelayBindings,
): Promise<Response | null> {
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
