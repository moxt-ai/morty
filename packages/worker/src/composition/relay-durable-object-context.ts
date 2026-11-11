import type { DurableObjectSqlDatabase } from "@morty-build/relay";
import { BackendProjectAccess } from "../../../relay/src/components/management/service/backend-project-access.ts";
import { ComputerManagementStorageDirectory } from "../../../relay/src/components/management/service/computer-management-storage-directory.ts";
import { ComputerManagementStorage } from "../../../relay/src/components/management/storage/computer-management-storage.ts";
import type {
    ComputerManagementStore,
    ComputerManagementStores,
} from "../../../relay/src/components/management/storage/computer-management-store.ts";
import { CloudflareRelayPeers } from "../../../relay/src/components/runtime/gateway/cloudflare-relay-peers.ts";
import { createRuntimeContext } from "../../../relay/src/components/runtime/runtime-context.ts";

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
    return createRuntimeContext({
        storages: { projectStores: stores },
        services: { projects, projectAccess: new BackendProjectAccess(controlStorage) },
        gateways: { peers: new CloudflareRelayPeers(state) },
        utilities: { waitUntil: (operation) => state.waitUntil(operation) },
        doDatabase: storage.database,
    });
}
