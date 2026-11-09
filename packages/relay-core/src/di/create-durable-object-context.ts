import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import type { ProjectCredentialAuthority } from "../gateway/project-access-authorizer.ts";
import { runtimeConnectionDurableObjectMigrations } from "../generated/runtime-connection-do-migrations.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { applyDurableObjectMigrations } from "../infra/durable-object-migrations.ts";
import { DurableObjectSqlDatabase } from "../infra/durable-object-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStoreResolver } from "../infra/project-store.ts";
import type { SessionStatusNotifications } from "../infra/session-status-notifications.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly stores: ProjectStoreResolver;
        readonly projects: ProjectStorageDirectory;
        readonly projectCredentials: ProjectCredentialAuthority;
        readonly doDatabase?: DoSqlDatabase;
        readonly notifications?: SessionStatusNotifications;
    },
) {
    applyDurableObjectMigrations(state.storage, runtimeConnectionDurableObjectMigrations, "connections/");
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase ?? new DurableObjectSqlDatabase(state.storage),
        storages: {
            projectStores: options.stores,
            projectDirectory: options.projects,
        },
        gateways: {
            peers: new CloudflareChannelPeers(state),
            projectCredentials: options.projectCredentials,
            ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
