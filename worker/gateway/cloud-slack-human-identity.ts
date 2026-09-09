import { verifyToken } from "@clerk/backend";
import type { HumanIdentity } from "@moxt-ai/app-slack-api/gateway";
import * as v from "valibot";
import {
    type HumanPrincipal,
    IdentityError,
} from "../../apps/slack/packages/api/src/service/identity/identity-service.ts";
import type { TenantShardingDirectory } from "../../apps/slack/packages/api/src/service/identity/tenant-context.ts";
import { TenantStorageError } from "../../apps/slack/packages/api/src/storage/tenant-storage-error.ts";

const claimsSchema = v.object({
    sub: v.pipe(v.string(), v.minLength(1)),
    sid: v.pipe(v.string(), v.minLength(1)),
    azp: v.pipe(v.string(), v.url()),
    iss: v.pipe(v.string(), v.url()),
    sts: v.optional(v.picklist(["active", "pending"])),
    org_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    o: v.optional(v.object({ id: v.pipe(v.string(), v.minLength(1)) })),
    mobius_d1_shard_id: v.optional(v.unknown()),
    mobius_r2_bucket_id: v.optional(v.unknown()),
    mobius_placement_revision: v.optional(v.unknown()),
});

/** Verifies Clerk session JWTs offline using the instance's configured public key. */
export class CloudSlackHumanIdentity implements HumanIdentity {
    readonly #publicKey: string;
    readonly #issuer: string;
    readonly #authorizedParties: readonly string[];
    readonly #tenantShards: TenantShardingDirectory;

    constructor(cx: {
        readonly config: {
            readonly clerkJwtKey: string;
            readonly clerkIssuerUrl: string;
            readonly clerkAuthorizedParties: readonly string[];
        };
        readonly gateways: { readonly tenantShardingDirectory: TenantShardingDirectory };
    }) {
        const { clerkJwtKey: publicKey, clerkIssuerUrl: issuer, clerkAuthorizedParties: authorizedParties } = cx.config;
        const { tenantShardingDirectory: tenantShards } = cx.gateways;
        this.#publicKey = publicKey;
        this.#issuer = issuer;
        this.#authorizedParties = authorizedParties;
        this.#tenantShards = tenantShards;
    }

    readonly authenticateHuman = async (authorization: string | null, signal: AbortSignal): Promise<HumanPrincipal> => {
        signal.throwIfAborted();
        if (authorization === null || !/^Bearer \S+$/u.test(authorization)) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Clerk session token is required");
        }
        try {
            const payload = await verifyToken(authorization.slice(7), {
                jwtKey: this.#publicKey,
                authorizedParties: [...this.#authorizedParties],
            });
            signal.throwIfAborted();
            const claims = v.parse(claimsSchema, payload);
            if (
                claims.sts === "pending" ||
                claims.iss !== this.#issuer ||
                !this.#authorizedParties.includes(claims.azp)
            ) {
                throw new IdentityError("AUTHENTICATION_FAILED", "Session origin is not authorized");
            }
            const tenantId = claims.o?.id ?? claims.org_id;
            if (tenantId === undefined) {
                throw new IdentityError("AUTHORIZATION_FAILED", "Select an active Clerk organization");
            }
            const { tenantSharding: resolution } = await this.#tenantShards.fromClaims(tenantId, claims, signal);
            const tenantSharding = resolution.hasShard ? resolution.shard : null;
            return {
                kind: "human",
                humanId: claims.sub,
                tenantId,
                tenantSharding,
            };
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof IdentityError || error instanceof TenantStorageError) {
                throw error;
            }
            throw new IdentityError("AUTHENTICATION_FAILED", "Clerk session could not be verified", { cause: error });
        }
    };
}
