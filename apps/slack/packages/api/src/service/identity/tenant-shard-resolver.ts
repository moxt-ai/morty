import type { TenantSharding } from "./identity-service";

export type TenantShardResolution =
    | { readonly hasShard: false }
    | { readonly hasShard: true; readonly shard: TenantSharding };
