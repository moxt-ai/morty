import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { computerDirectory, accountProvisioner as provision } from "../../directory/composition.ts";
import { ComputerRelayGateway } from "../gateway/computer-relay.ts";

export function accountProvisioner(bindings: CloudBindings) {
    return provision(bindings, (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId));
}

/** Ownership is always read from the directory, never from a cached copy in this computer. */
export async function readComputerOwner(bindings: CloudBindings, computerId: string, signal: AbortSignal) {
    return await computerDirectory(
        bindings,
        (id) => new ComputerRelayGateway(relayBindings(bindings), id),
    ).readComputerOwner(computerId, signal);
}
