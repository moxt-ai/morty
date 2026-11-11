import { createRelayDependencies, type LocalSessionOperations } from "@morty-build/relay";
import { createRelayAccessServices, type RelayAccessServices } from "@morty-build/relay/services";
import type { ComputerManagementStore } from "../../../relay/src/components/management/storage/computer-management-store.ts";
import { CloudflareChannelRuntime } from "../gateway/cloudflare-channel-runtime.ts";
import { ComputerDurableObjectStores } from "../gateway/computer-durable-object-store.ts";
import type { RelayBindings } from "./relay-bindings.ts";

export interface ComputerExecution {
    readonly computerId: string;
    readonly store: ComputerManagementStore;
    readonly channel: (computerId: string, request: Request) => Promise<Response>;
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
        channelGateway: new CloudflareChannelRuntime(bindings.COMPUTER_RELAY, execution?.channel),
        nowEpochMilliseconds: () => Date.now(),
    };
}

export function composeRelayContext(access: RelayAccessServices, ports: ReturnType<typeof createRelayPorts>) {
    return createRelayDependencies({
        control: access.control,
        stores: access.stores,
        identityStores: access.identityStores,
        projects: access.projects,
        gateways: ports,
    });
}
