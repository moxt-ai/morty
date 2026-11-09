import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import type { PlatformProjectStore, PlatformProjectStores } from "../infra/platform-project-store.ts";
import { AppCredentialProjectAccess } from "../service/app-credential-project-access.ts";
import { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import { type PlatformStorageBindings, PlatformStorageRegistry } from "../storage/platform-storage-registry.ts";
import type { ComputerRelay } from "./computer-relay.ts";

export interface PlatformDurableObjectEnvironment extends PlatformStorageBindings {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly COMPUTER_RELAY: DurableObjectNamespace<ComputerRelay>;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage: {
        readonly database: DurableObjectSqlDatabase;
        readonly storeFor: (computerId: string) => PlatformProjectStore;
    },
) {
    const stores: PlatformProjectStores = {
        forProject: storage.storeFor,
        resolve: (placement) => {
            if (!placement.hasShard) {
                throw new Error("Missing computer placement");
            }
            return storage.storeFor(placement.shard.d1ShardId);
        },
    };
    const registry = new PlatformStorageRegistry(environment);
    const controlStorage = new PlatformControlPlaneStorage(environment.PLATFORM_DIRECTORY_DATABASE, stores);
    const projects = new PlatformProjectStorageDirectory(registry, controlStorage);
    return createDurableObjectContext(state, {
        stores,
        projects,
        projectCredentials: new AppCredentialProjectAccess(controlStorage),
        doDatabase: storage.database,
    });
}
