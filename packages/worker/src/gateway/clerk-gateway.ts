import { verifyToken } from "@clerk/backend";
import * as v from "valibot";
import { type Session, sessionSchema } from "../entity/authentication/session.ts";
import { deploymentEnvironmentSchema, tenantPlacementClaimsSchema } from "../entity/tenant-placement.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { isConfiguredTenantPlacement } from "../service/tenant-placement.ts";
import type { AuthenticationConfiguration } from "../storage/authentication-configuration.ts";

const claimsSchema = v.pipe(
    v.object({
        sub: v.pipe(v.string(), v.startsWith("user_")),
        sid: v.pipe(v.string(), v.startsWith("sess_")),
        sts: v.optional(v.picklist(["active", "pending"])),
        mobius_d1_shard_id: v.optional(v.unknown()),
        mobius_r2_bucket_id: v.optional(v.unknown()),
        mobius_placement_revision: v.optional(v.unknown()),
        o: v.optional(v.pipe(v.object({ id: v.pipe(v.string(), v.startsWith("org_")) }), v.readonly())),
    }),
    v.readonly(),
);

export class ClerkGateway {
    readonly #bindings: Pick<CloudBindings, "DEPLOY_ENVIRONMENT">;
    constructor(cx: { readonly config: { readonly bindings: Pick<CloudBindings, "DEPLOY_ENVIRONMENT"> } }) {
        this.#bindings = cx.config.bindings;
    }
    readonly verify = async (
        token: string,
        configuration: AuthenticationConfiguration,
        signal: AbortSignal,
    ): Promise<Session | null> => {
        signal.throwIfAborted();
        let verified: unknown;
        try {
            verified = await verifyToken(token, {
                jwtKey: configuration.CLERK_JWT_KEY,
                authorizedParties: [configuration.APP_ORIGIN],
            });
        } catch {
            signal.throwIfAborted();
            return null;
        }
        signal.throwIfAborted();
        const claims = v.safeParse(claimsSchema, verified);
        if (!claims.success || claims.output.sts === "pending") {
            return null;
        }
        const placementClaims = v.safeParse(tenantPlacementClaimsSchema, claims.output);
        const environment = v.safeParse(deploymentEnvironmentSchema, this.#bindings.DEPLOY_ENVIRONMENT);
        const claimed = placementClaims.success
            ? {
                  d1ShardId: placementClaims.output.mobius_d1_shard_id,
                  r2BucketId: placementClaims.output.mobius_r2_bucket_id,
                  revision: placementClaims.output.mobius_placement_revision,
              }
            : null;
        const placement =
            claimed !== null && environment.success && isConfiguredTenantPlacement(environment.output, claimed)
                ? claimed
                : null;
        return v.parse(sessionSchema, {
            userId: claims.output.sub,
            sessionId: claims.output.sid,
            organizationId: claims.output.o?.id ?? null,
            placement,
        });
    };
}
