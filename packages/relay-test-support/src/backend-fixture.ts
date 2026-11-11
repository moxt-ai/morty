import { ComputerManagementBackendService } from "../../relay/src/components/computer/service/computer-management-backend-service.ts";
import {
    type ComputerControlCommand,
    requestComputerControl,
} from "../../relay/src/components/runtime/service/computer-control-request.ts";
import type { RelayBindings } from "../../worker/src/composition/relay-bindings.ts";
import {
    composeRelayContext,
    createHostedRelayAccess,
    createRelayPorts,
} from "../../worker/src/composition/relay-services.ts";

/** Exercises real services through the Cloudflare storage and Runtime boundaries. */
export function createTestComputerBackend(env: RelayBindings, computerId: string) {
    const access = createHostedRelayAccess(env);
    return new ComputerManagementBackendService(
        computerId,
        composeRelayContext(access, createRelayPorts(env)),
        access.sessionAccess,
        env.MORTY_SESSION_SIGNING_SECRET,
    );
}

/** Local control scenarios use a real internal Host connection, with no retired HTTP management API. */
export async function requestTestComputerControl(
    env: RelayBindings,
    computerId: string,
    command: ComputerControlCommand,
    signal: AbortSignal,
) {
    const socket = await createTestComputerBackend(env, computerId).openHost(signal);
    return requestComputerControl(socket, command, signal);
}
