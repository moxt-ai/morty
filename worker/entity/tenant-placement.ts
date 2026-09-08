import * as v from "valibot";

export const deploymentEnvironmentSchema = v.picklist(["staging", "production"]);

export const tenantRegionSchema = v.picklist(["apac", "wnam"]);

export const tenantPlacementSchema = v.pipe(
    v.object({
        d1ShardId: v.pipe(v.string(), v.minLength(1)),
        r2BucketId: v.pipe(v.string(), v.minLength(1)),
        revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    v.readonly(),
);
export type TenantPlacement = v.InferOutput<typeof tenantPlacementSchema>;

export const tenantPlacementMetadataSchema = v.pipe(
    v.object({
        mobiusCloud: v.pipe(v.object({ placement: tenantPlacementSchema }), v.readonly()),
    }),
    v.readonly(),
);

const placementRevisionClaimSchema = v.union([
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    v.pipe(
        v.string(),
        v.regex(/^[1-9]\d*$/u),
        v.transform((value) => Number.parseInt(value, 10)),
        v.integer(),
        v.minValue(1),
    ),
]);

export const tenantPlacementClaimsSchema = v.pipe(
    v.object({
        mobius_d1_shard_id: v.pipe(v.string(), v.minLength(1)),
        mobius_r2_bucket_id: v.pipe(v.string(), v.minLength(1)),
        mobius_placement_revision: placementRevisionClaimSchema,
    }),
    v.readonly(),
);
