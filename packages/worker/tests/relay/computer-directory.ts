import type { CloudBindings } from "../../src/contracts/cloud-bindings.ts";
import { relayBindings } from "../../src/contracts/relay-bindings.ts";
import { computerDirectory as directory } from "../../src/directory/composition.ts";
import { ComputerRelayGateway } from "../../src/worker/gateway/computer-relay.ts";

export function computerDirectory(bindings: CloudBindings) {
    return directory(bindings, (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId));
}

export async function readComputerOwner(bindings: CloudBindings, computerId: string, signal: AbortSignal) {
    return await computerDirectory(bindings).readComputerOwner(computerId, signal);
}
