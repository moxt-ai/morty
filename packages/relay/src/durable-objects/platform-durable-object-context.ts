import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { AccountDurableObjectStores } from "../gateway/account-durable-object-store.ts";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import { AppCredentialProjectAccess } from "../service/app-credential-project-access.ts";
import { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import { type PlatformStorageBindings, PlatformStorageRegistry } from "../storage/platform-storage-registry.ts";
import type { AccountDO } from "./account-do.ts";

export interface PlatformDurableObjectEnvironment extends PlatformStorageBindings {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly ACCOUNT_RELAY: DurableObjectNamespace<AccountDO>;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage: { readonly database: DurableObjectSqlDatabase },
) {
    const stores = new AccountDurableObjectStores(environment.ACCOUNT_RELAY);
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
