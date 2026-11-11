import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { computerDirectory as directory, accountProvisioner as provision } from "../../directory/composition.ts";
import { ComputerRelayGateway } from "../gateway/computer-relay.ts";

export function computerDirectory(bindings: CloudBindings) {
    return directory(bindings, (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId));
}

export function accountProvisioner(bindings: CloudBindings) {
    return provision(bindings, (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId));
}

export async function readComputerOwner(bindings: CloudBindings, computerId: string, signal: AbortSignal) {
    return await computerDirectory(bindings).readComputerOwner(computerId, signal);
}
