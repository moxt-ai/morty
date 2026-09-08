import { type TenantContext, type TenantShardingDirectory, TenantStorageError } from "@moxt-ai/app-slack-api";
import * as v from "valibot";
import {
    deploymentEnvironmentSchema,
    tenantPlacementClaimsSchema,
    tenantPlacementSchema,
} from "../entity/tenant-placement.ts";
import { hasTenantCreationBindings } from "../infra/allocator-bindings.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { isConfiguredTenantPlacement } from "../service/tenant-placement.ts";

export class CloudTenantShardingDirectory implements TenantShardingDirectory {
    readonly bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.bindings = bindings;
    }

    readonly #context = (tenantId: string, placement: v.InferOutput<typeof tenantPlacementSchema>): TenantContext => {
        const environment = v.safeParse(deploymentEnvironmentSchema, this.bindings.DEPLOY_ENVIRONMENT);
        if (!environment.success || !isConfiguredTenantPlacement(environment.output, placement)) {
            throw new TenantStorageError();
        }
        return { tenantId, tenantSharding: { hasShard: true, shard: placement } };
    };

    readonly fromClaims = async (tenantId: string, value: unknown, signal: AbortSignal): Promise<TenantContext> => {
        signal.throwIfAborted();
        const claims = v.safeParse(tenantPlacementClaimsSchema, value);
        if (!claims.success) {
            throw new TenantStorageError();
        }
        return this.#context(tenantId, {
            d1ShardId: claims.output.mobius_d1_shard_id,
            r2BucketId: claims.output.mobius_r2_bucket_id,
            revision: claims.output.mobius_placement_revision,
        });
    };

    readonly resolve = async (tenantId: string, parent: AbortSignal): Promise<TenantContext> => {
        parent.throwIfAborted();
        if (!hasTenantCreationBindings(this.bindings)) {
            throw new TenantStorageError();
        }
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        try {
            const namespace = this.bindings.TENANT_PLACEMENT_ALLOCATOR;
            const response = await namespace.get(namespace.idFromName(this.bindings.DEPLOY_ENVIRONMENT)).fetch(
                new Request("https://tenant-placement.internal/resolve", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        environment: this.bindings.DEPLOY_ENVIRONMENT,
                        organizationId: tenantId,
                    }),
                    signal,
                }),
            );
            const value: unknown = await response.json();
            signal.throwIfAborted();
            const parsed = v.safeParse(v.object({ placement: tenantPlacementSchema }), value);
            if (!response.ok || !parsed.success) {
                throw new TenantStorageError();
            }
            return this.#context(tenantId, parsed.output.placement);
        } catch (cause) {
            parent.throwIfAborted();
            throw new TenantStorageError({ cause });
        }
    };
}
