import type { TenantShardResolution } from "../service/identity/tenant-shard-resolver";
import type { SqlDatabase } from "./sql-database";

export interface DatabaseResolver {
    readonly resolve: (sharding: TenantShardResolution) => SqlDatabase;
}
