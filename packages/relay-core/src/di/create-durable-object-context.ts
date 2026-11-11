import type { ComputerCredentialAuthority } from "../entity/authentication/computer-authorization.ts";
import { CloudflareRelayPeers } from "../gateway/cloudflare-relay-peers.ts";
import type { ComputerStorageDirectory } from "../infra/computer-storage-directory.ts";
import type { ComputerStoreResolver } from "../infra/computer-store.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly stores: ComputerStoreResolver;
        readonly computers: ComputerStorageDirectory;
        readonly computerCredentials: ComputerCredentialAuthority;
        readonly doDatabase: DoSqlDatabase;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase,
        storages: {
            computerStores: options.stores,
            computerDirectory: options.computers,
        },
        gateways: {
            peers: new CloudflareRelayPeers(state),
            computerCredentials: options.computerCredentials,
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
