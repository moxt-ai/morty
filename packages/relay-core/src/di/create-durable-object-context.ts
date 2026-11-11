import type { ProjectCredentialAuthority } from "../entity/authentication/project-authorization.ts";
import { CloudflareRelayPeers } from "../gateway/cloudflare-relay-peers.ts";
import type { ComputerRelayStoreResolver } from "../infra/computer-relay-store.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly stores: ComputerRelayStoreResolver;
        readonly projects: ProjectStorageDirectory;
        readonly projectCredentials: ProjectCredentialAuthority;
        readonly doDatabase: DoSqlDatabase;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase,
        storages: {
            projectStores: options.stores,
            projectDirectory: options.projects,
        },
        gateways: {
            peers: new CloudflareRelayPeers(state),
            projectCredentials: options.projectCredentials,
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
