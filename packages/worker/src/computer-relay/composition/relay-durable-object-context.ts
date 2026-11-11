import type { ComputerAccounts } from "../../contracts/computer-accounts.ts";
import { ComputerAccessService } from "../../directory/service/computer-access-service.ts";
import { ComputerManagementService } from "../../directory/service/computer-management-service.ts";
import { ComputerManagementStorage } from "../../directory/storage/computer-management-storage.ts";
import type { ComputerManagementStore } from "../components/management/storage/computer-management-store.ts";
import { CloudflareRelayPeers } from "../components/runtime/gateway/cloudflare-relay-peers.ts";
import { createRuntimeContext } from "../components/runtime/runtime-context.ts";
import type { DurableObjectDatabase } from "../infra/durable-object-database.ts";

export function createRelayDurableObjectContext(
    state: DurableObjectState,
    storage: {
        readonly database: DurableObjectDatabase;
        readonly accounts: ComputerAccounts;
        readonly storeFor: (computerId: string) => ComputerManagementStore;
    },
) {
    const stores = {
        forProject: storage.storeFor,
    };
    const controlStorage = new ComputerManagementStorage(storage.accounts, stores);
    return createRuntimeContext({
        storages: {
            projectStore: {
                readActiveGeneration: (computerId, signal) =>
                    storage.storeFor(computerId).readActiveGeneration(computerId, signal),
            },
        },
        services: {
            computerAccounts: new ComputerManagementService(controlStorage),
            projectAccess: new ComputerAccessService(controlStorage),
        },
        gateways: { peers: new CloudflareRelayPeers(state) },
        utilities: { waitUntil: (operation) => state.waitUntil(operation) },
        doDatabase: storage.database,
    });
}
