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
import { CloudflareComputerRelay } from "../../worker/src/gateway/cloudflare-computer-relay.ts";

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

/**
 * Seeds a revoked Computer: the Relay revokes one when its daemon credential is reused, which a scenario about the
 * revoked state need not stage. The revocation commits in the Computer's storage and closes its daemon connection.
 */
export async function revokeTestComputer(env: RelayBindings, computerId: string, signal: AbortSignal) {
    await env.COMPUTER_RELAY.getByName(computerId).revokeComputer(computerId, {
        computerId,
        now: Date.now(),
        actorKind: "system",
        actorId: computerId,
        auditId: `test-revocation-${crypto.randomUUID()}`,
    });
    await new CloudflareComputerRelay(env.COMPUTER_RELAY).disconnectComputer({ computerId }, signal);
}
