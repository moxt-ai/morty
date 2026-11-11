import { createWorkerContext } from "@morty-build/relay-core";
import {
    createRelayAccessServices,
    createRelayGateways,
    type RelayRelayBindings,
} from "../../relay/src/relay-worker.ts";
import { ComputerBackendService } from "../../relay/src/service/computer-backend-service.ts";
import {
    type RuntimeControlCommand,
    requestRuntimeControl,
} from "../../relay-core/src/service/pairing/runtime-control-request.ts";

/** Exercises real services through the Cloudflare storage and Runtime boundaries. */
export function createTestComputerBackend(env: RelayRelayBindings, computerId: string) {
    const access = createRelayAccessServices(env);
    return new ComputerBackendService(
        computerId,
        createWorkerContext({
            applications: access.control,
            authorization: access.control,
            stores: access.stores,
            identityStores: access.identityStores,
            projects: access.projects,
            gateways: createRelayGateways(env),
        }),
        access.sessionAccess,
        env.MORTY_SESSION_SIGNING_SECRET,
    );
}

/** Local control scenarios use a real internal Host connection, with no retired HTTP management API. */
export async function requestTestRuntimeControl(
    env: RelayRelayBindings,
    computerId: string,
    command: RuntimeControlCommand,
    signal: AbortSignal,
) {
    const socket = await createTestComputerBackend(env, computerId).openHost(signal);
    return requestRuntimeControl(socket, command, signal);
}
