import {
    type AccountProvisioner,
    provisionAccount,
} from "../components/management/service/account-provisioning-service.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { relayBindings } from "./relay-bindings.ts";
import { createHostedRelayAccess } from "./relay-services.ts";

export function accountProvisioner(bindings: CloudBindings): AccountProvisioner {
    return (userId, reference, location, signal) =>
        provisionAccount(createHostedRelayAccess(relayBindings(bindings)).control, userId, reference, location, signal);
}

/** Resolves ownership from the directory without persisting a second copy in the computer. */
export async function readComputerOwner(bindings: CloudBindings, computerId: string, signal: AbortSignal) {
    return await createHostedRelayAccess(relayBindings(bindings)).control.readComputerOwner(computerId, signal);
}
