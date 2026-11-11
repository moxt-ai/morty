import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import type { ProjectCredentialAuthority } from "../gateway/project-access-authorizer.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStoreResolver } from "../infra/project-store.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly stores: ProjectStoreResolver;
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
            peers: new CloudflareChannelPeers(state),
            projectCredentials: options.projectCredentials,
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
