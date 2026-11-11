import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { ComputerManagementStorageDirectory } from "../infra/computer-management-storage-directory.ts";
import type { ComputerManagementStore, ComputerManagementStores } from "../infra/computer-management-store.ts";
import { BackendProjectAccess } from "../service/backend-project-access.ts";
import { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import type { ComputerRelay } from "./computer-relay.ts";

export interface RelayDurableObjectEnvironment {
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
    readonly COMPUTER_RELAY: DurableObjectNamespace<ComputerRelay>;
}

export function createRelayDurableObjectContext(
    state: DurableObjectState,
    environment: RelayDurableObjectEnvironment,
    storage: {
        readonly database: DurableObjectSqlDatabase;
        readonly storeFor: (computerId: string) => ComputerManagementStore;
    },
) {
    const stores: ComputerManagementStores = {
        forProject: storage.storeFor,
        resolve: (placement) => {
            if (!placement.hasShard) {
                throw new Error("Missing computer placement");
            }
            return storage.storeFor(placement.shard.d1ShardId);
        },
    };
    const controlStorage = new ComputerManagementStorage(environment.RELAY_DIRECTORY_DATABASE, stores);
    const projects = new ComputerManagementStorageDirectory(controlStorage);
    return createDurableObjectContext(state, {
        stores,
        projects,
        projectCredentials: new BackendProjectAccess(controlStorage),
        doDatabase: storage.database,
    });
}
