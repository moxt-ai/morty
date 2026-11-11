import { ComputerBackendService } from "../../relay/src/service/computer-backend-service.ts";
import {
    type RuntimeControlCommand,
    requestRuntimeControl,
} from "../../relay-core/src/service/pairing/runtime-control-request.ts";
import type { RelayBindings } from "../../worker/src/composition/relay-bindings.ts";
import {
    composeRelayContext,
    createHostedRelayAccess,
    createRelayPorts,
} from "../../worker/src/composition/relay-services.ts";

/** Exercises real services through the Cloudflare storage and Runtime boundaries. */
export function createTestComputerBackend(env: RelayBindings, computerId: string) {
    const access = createHostedRelayAccess(env);
    return new ComputerBackendService(
        computerId,
        composeRelayContext(access, createRelayPorts(env)),
        access.sessionAccess,
        env.MORTY_SESSION_SIGNING_SECRET,
    );
}

/** Local control scenarios use a real internal Host connection, with no retired HTTP management API. */
export async function requestTestRuntimeControl(
    env: RelayBindings,
    computerId: string,
    command: RuntimeControlCommand,
    signal: AbortSignal,
) {
    const socket = await createTestComputerBackend(env, computerId).openHost(signal);
    return requestRuntimeControl(socket, command, signal);
}
