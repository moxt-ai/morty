import type { ComputerStore } from "@morty-build/relay-core";
import { SessionAccessSigner } from "../entity/session-access-credential.ts";
import { ComputerManagementStorageDirectory } from "../infra/computer-management-storage-directory.ts";
import type { ComputerManagementStores } from "../infra/computer-management-store.ts";
import { ComputerManagementService } from "../service/computer-management-service.ts";
import { SessionAccessService } from "../service/session-access-service.ts";
import { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

export function createRelayAccessServices(dependencies: {
    readonly database: D1Database;
    readonly stores: ComputerManagementStores;
    readonly identityStores: readonly ComputerStore[];
    readonly sessionSigningSecret: string;
}) {
    const controlStorage = new ComputerManagementStorage(dependencies.database, dependencies.stores);
    const control = new ComputerManagementService(controlStorage);
    return {
        stores: dependencies.stores,
        identityStores: dependencies.identityStores,
        control,
        sessionAccess: new SessionAccessService(control, new SessionAccessSigner(dependencies.sessionSigningSecret)),
        computers: new ComputerManagementStorageDirectory(controlStorage),
    };
}

export type RelayAccessServices = ReturnType<typeof createRelayAccessServices>;
