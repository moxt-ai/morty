import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { ComputerManagementStorageDirectory } from "../infra/computer-management-storage-directory.ts";
import type { ComputerManagementStore, ComputerManagementStores } from "../infra/computer-management-store.ts";
import type { ComputerSessionAccess } from "../infra/computer-session-access.ts";
import { AppCredentialProjectAccess } from "../service/app-credential-project-access.ts";
import { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { type RelayStorageBindings, RelayStorageRegistry } from "../storage/relay-storage-registry.ts";
import type { ComputerRelay } from "./computer-relay.ts";

export interface RelayDurableObjectEnvironment extends RelayStorageBindings {
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
    readonly COMPUTER_RELAY: DurableObjectNamespace<ComputerRelay>;
}

export function createRelayDurableObjectContext(
    state: DurableObjectState,
    environment: RelayDurableObjectEnvironment,
    storage: {
        readonly database: DurableObjectSqlDatabase;
        readonly storeFor: (computerId: string) => ComputerManagementStore;
        readonly sessionAccessFor: (computerId: string) => ComputerSessionAccess;
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
    const registry = new RelayStorageRegistry(environment);
    const controlStorage = new ComputerManagementStorage(environment.RELAY_DIRECTORY_DATABASE, stores);
    const projects = new ComputerManagementStorageDirectory(registry, controlStorage);
    return createDurableObjectContext(state, {
        stores,
        projects,
        projectCredentials: new AppCredentialProjectAccess(controlStorage, { forComputer: storage.sessionAccessFor }),
        doDatabase: storage.database,
    });
}
