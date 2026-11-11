import { createRelayAccessServices, type RelayAccessServices } from "@morty-build/relay/services";
import {
    createRelayDependencies,
    type LocalSessionOperations,
    type RelayInfrastructure,
} from "@morty-build/relay-core";
import type { ComputerManagementStore } from "../../../relay/src/infra/computer-management-store.ts";
import { CloudflareComputerGateway } from "../gateway/cloudflare-computer-gateway.ts";
import { ComputerDurableObjectStores } from "../gateway/computer-durable-object-store.ts";
import type { RelayBindings } from "./relay-bindings.ts";

export interface ComputerExecution {
    readonly computerId: string;
    readonly store: ComputerManagementStore;
    readonly dispatchComputerRequest: (computerId: string, request: Request) => Promise<Response>;
    readonly operations: LocalSessionOperations;
}

export function createHostedRelayAccess(bindings: RelayBindings, execution: ComputerExecution | null = null) {
    return createRelayAccessServices({
        database: bindings.RELAY_DIRECTORY_DATABASE,
        stores: new ComputerDurableObjectStores(bindings.COMPUTER_RELAY, execution),
        identityStores: execution === null ? [] : [execution.store],
        sessionSigningSecret: bindings.MORTY_SESSION_SIGNING_SECRET,
    });
}

export function createRelayPorts(bindings: RelayBindings, execution: ComputerExecution | null = null) {
    return {
        computerGateway: new CloudflareComputerGateway(bindings.COMPUTER_RELAY, execution?.dispatchComputerRequest),
        ...(execution === null ? {} : { runtimeOperations: execution.operations }),
        nowEpochMilliseconds: () => Date.now(),
    } satisfies RelayInfrastructure["gateways"];
}

export function composeRelayContext(access: RelayAccessServices, ports: RelayInfrastructure["gateways"]) {
    return createRelayDependencies({
        authentication: { computers: access.control },
        machineAccounts: access.control,
        stores: access.stores,
        identityStores: access.identityStores,
        computers: access.computers,
        logger: console,
        gateways: ports,
    });
}
