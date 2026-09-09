import { D1DatabaseAdapter } from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { MobiusTenantShardingDirectory } from "../gateway/mobius-tenant-sharding-directory.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { CloudMobiusBucketResolver, CloudMobiusDatabaseResolver } from "../storage/mobius-storage-resolvers.ts";
import { configuredD1Candidates } from "../storage/slack-storage-resolvers.ts";

export function createMobiusStorage(bindings: CloudBindings) {
    const host = { config: { bindings } };
    return {
        databases: new CloudMobiusDatabaseResolver(host),
        buckets: new CloudMobiusBucketResolver(host),
        tenants: new MobiusTenantShardingDirectory(host),
        identityDatabases: configuredD1Candidates(bindings).map(({ database }) => D1DatabaseAdapter.from(database)),
    };
}
