import { type HumanPrincipal, IdentityError, type TenantSharding } from "../../src/service/identity/identity-service";
import type { TenantShardingDirectory } from "../../src/service/identity/tenant-context";

// The host owns authentication. This stateful provider owns credentials and tenant membership.
export class InMemoryHumanIdentity {
    readonly #sessions = new Map<
        string,
        { readonly tenantId: string | null; readonly placement: TenantSharding | null }
    >();
    readonly #tenants: TenantShardingDirectory;
    constructor(tenants: TenantShardingDirectory) {
        this.#tenants = tenants;
    }

    readonly humanToken = async (
        tenantId: string | null = "tenant-1",
        placement: TenantSharding | null = null,
    ): Promise<string> => {
        const token = crypto.randomUUID();
        this.#sessions.set(token, { tenantId, placement });
        return token;
    };

    readonly authenticateHuman = async (authorization: string | null, signal: AbortSignal): Promise<HumanPrincipal> => {
        signal.throwIfAborted();
        const session = authorization?.startsWith("Bearer ") ? this.#sessions.get(authorization.slice(7)) : undefined;
        if (session === undefined) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Host session is invalid");
        }
        if (session.tenantId === null) {
            throw new IdentityError("AUTHORIZATION_FAILED", "Select a workspace");
        }
        const placement = session.placement;
        const tenant = await this.#tenants.fromClaims(
            session.tenantId,
            placement === null
                ? {}
                : {
                      mobius_d1_shard_id: placement.d1ShardId,
                      mobius_r2_bucket_id: placement.r2BucketId,
                      mobius_placement_revision: placement.revision,
                  },
            signal,
        );
        return {
            kind: "human",
            humanId: "human-1",
            tenantId: session.tenantId,
            tenantSharding: tenant.tenantSharding.hasShard ? tenant.tenantSharding.shard : null,
        };
    };
}
