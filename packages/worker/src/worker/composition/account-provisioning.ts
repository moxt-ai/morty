import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { accountProvisioner as provision } from "../../directory/composition.ts";
import { ComputerRelayGateway } from "../gateway/computer-relay.ts";

export function accountProvisioner(bindings: CloudBindings) {
    return provision(bindings, (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId));
}
