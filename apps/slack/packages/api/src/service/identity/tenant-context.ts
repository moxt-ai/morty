import type { HumanPrincipal } from "./identity-service";
import type { TenantShardResolution } from "./tenant-shard-resolver";

export function humanTenant(principal: HumanPrincipal): TenantContext {
    return {
        tenantId: principal.tenantId,
        tenantSharding:
            principal.tenantSharding === null
                ? { hasShard: false }
                : { hasShard: true, shard: principal.tenantSharding },
    };
}

export interface TenantContext {
    readonly tenantId: string;
    readonly tenantSharding: TenantShardResolution;
}

export interface TenantShardingDirectory {
    readonly resolve: (tenantId: string, signal: AbortSignal) => Promise<TenantContext>;
    readonly fromClaims: (tenantId: string, claims: unknown, signal: AbortSignal) => Promise<TenantContext>;
}

export class StandaloneTenantShardingDirectory implements TenantShardingDirectory {
    readonly resolve = async (tenantId: string, signal: AbortSignal): Promise<TenantContext> => {
        signal.throwIfAborted();
        return { tenantId, tenantSharding: { hasShard: false } };
    };
    readonly fromClaims = async (tenantId: string, _claims: unknown, signal: AbortSignal): Promise<TenantContext> =>
        await this.resolve(tenantId, signal);
}
