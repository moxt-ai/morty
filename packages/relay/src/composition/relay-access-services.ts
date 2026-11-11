import type { ComputerRelayStore } from "@morty-build/relay";
import { ComputerManagementService } from "../components/management/service/computer-management-service.ts";
import { ComputerManagementStorageDirectory } from "../components/management/service/computer-management-storage-directory.ts";
import { ComputerManagementStorage } from "../components/management/storage/computer-management-storage.ts";
import type { ComputerManagementStores } from "../components/management/storage/computer-management-store.ts";
import { SessionAccessSigner } from "../components/runtime/entity/session-access-credential.ts";
import { SessionAccessService } from "../components/runtime/service/session-access-service.ts";

export function createRelayAccessServices(dependencies: {
    readonly database: D1Database;
    readonly stores: ComputerManagementStores;
    readonly identityStores: readonly ComputerRelayStore[];
    readonly sessionSigningSecret: string;
}) {
    const controlStorage = new ComputerManagementStorage(dependencies.database, dependencies.stores);
    const control = new ComputerManagementService(controlStorage);
    return {
        stores: dependencies.stores,
        identityStores: dependencies.identityStores,
        control,
        sessionAccess: new SessionAccessService(control, new SessionAccessSigner(dependencies.sessionSigningSecret)),
        projects: new ComputerManagementStorageDirectory(controlStorage),
    };
}

export type RelayAccessServices = ReturnType<typeof createRelayAccessServices>;
