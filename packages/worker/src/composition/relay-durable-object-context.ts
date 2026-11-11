import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { ComputerManagementStorageDirectory } from "../../../relay/src/infra/computer-management-storage-directory.ts";
import type {
    ComputerManagementStore,
    ComputerManagementStores,
} from "../../../relay/src/infra/computer-management-store.ts";
import { BackendProjectAccess } from "../../../relay/src/service/backend-project-access.ts";
import { ComputerManagementStorage } from "../../../relay/src/storage/computer-management-storage.ts";

export interface RelayDurableObjectEnvironment {
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
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
        resolve: storage.storeFor,
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
