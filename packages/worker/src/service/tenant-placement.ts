import * as v from "valibot";
import d1InventoryValue from "../../../../infra/d1-shards.json" with { type: "json" };
import r2InventoryValue from "../../../../infra/r2-buckets.json" with { type: "json" };
import {
    deploymentEnvironmentSchema,
    type TenantPlacement,
    tenantPlacementMetadataSchema,
    tenantRegionSchema,
} from "../entity/tenant-placement.ts";
import { SerialExecutor } from "../infra/serial-executor.ts";

const d1InventorySchema = v.pipe(
    v.object({
        production: v.array(
            v.pipe(
                v.object({
                    id: v.pipe(v.string(), v.minLength(1)),
                    location_hint: tenantRegionSchema,
                }),
                v.readonly(),
            ),
        ),
        staging: v.array(
            v.pipe(
                v.object({
                    id: v.pipe(v.string(), v.minLength(1)),
                    location_hint: tenantRegionSchema,
                }),
                v.readonly(),
            ),
        ),
    }),
    v.readonly(),
);

const r2InventorySchema = v.pipe(
    v.object({
        production: v.array(
            v.pipe(
                v.object({
                    id: v.pipe(v.string(), v.minLength(1)),
                    location_hint: tenantRegionSchema,
                }),
                v.readonly(),
            ),
        ),
        staging: v.array(
            v.pipe(
                v.object({
                    id: v.pipe(v.string(), v.minLength(1)),
                    location_hint: tenantRegionSchema,
                }),
                v.readonly(),
            ),
        ),
    }),
    v.readonly(),
);

const d1Inventory = v.parse(d1InventorySchema, d1InventoryValue);
const r2Inventory = v.parse(r2InventorySchema, r2InventoryValue);

export function isConfiguredTenantPlacement(
    environment: "staging" | "production",
    placement: TenantPlacement,
): boolean {
    const shard = d1Inventory[environment].find((candidate) => candidate.id === placement.d1ShardId);
    const bucket = r2Inventory[environment].find((candidate) => candidate.id === placement.r2BucketId);
    return shard !== undefined && bucket !== undefined && shard.location_hint === bucket.location_hint;
}

const allocationRequestSchema = v.pipe(
    v.strictObject({
        environment: deploymentEnvironmentSchema,
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
        region: tenantRegionSchema,
        userId: v.pipe(v.string(), v.startsWith("user_")),
    }),
    v.readonly(),
);

const metadataEnvelopeSchema = v.pipe(
    v.object({
        mobiusCloud: v.optional(v.object({ placement: v.optional(v.unknown()) })),
    }),
    v.readonly(),
);

export interface OrganizationDirectory {
    readonly get: (
        organizationId: string,
        signal: AbortSignal,
    ) => Promise<{
        readonly id: string;
        readonly publicMetadata: unknown;
    } | null>;
    readonly list: (
        signal: AbortSignal,
    ) => Promise<readonly { readonly id: string; readonly publicMetadata: unknown }[]>;
    readonly create: (
        input: {
            readonly createdBy: string;
            readonly name: string;
            readonly publicMetadata: unknown;
        },
        signal: AbortSignal,
    ) => Promise<{
        readonly canDelete: boolean;
        readonly id: string;
        readonly name: string;
        readonly publicMetadata: unknown;
    }>;
}

const placementLookupRequestSchema = v.pipe(
    v.strictObject({
        environment: deploymentEnvironmentSchema,
        organizationId: v.pipe(v.string(), v.startsWith("org_")),
    }),
    v.readonly(),
);

class TenantPlacementError extends Error {
    readonly code: "INVALID_INPUT" | "UNAVAILABLE";

    constructor(code: "INVALID_INPUT" | "UNAVAILABLE", options?: ErrorOptions) {
        super(code, options);
        this.code = code;
        this.name = "TenantPlacementError";
    }
}

function selectPlacement(
    environment: "staging" | "production",
    region: "apac" | "wnam",
    organizations: readonly {
        readonly id: string;
        readonly publicMetadata: unknown;
    }[],
): TenantPlacement {
    const shards = d1Inventory[environment].filter((shard) => shard.location_hint === region);
    const [firstShard, ...remainingShards] = shards;
    const buckets = r2Inventory[environment].filter((bucket) => bucket.location_hint === region);
    const [bucket] = buckets;
    if (firstShard === undefined || bucket === undefined || buckets.length !== 1) {
        throw new TenantPlacementError("UNAVAILABLE");
    }

    const counts = new Map(shards.map((shard) => [shard.id, 0]));
    for (const organization of organizations) {
        const envelope = v.safeParse(metadataEnvelopeSchema, organization.publicMetadata);
        if (!envelope.success || envelope.output.mobiusCloud?.placement === undefined) {
            continue;
        }
        const metadata = v.safeParse(tenantPlacementMetadataSchema, organization.publicMetadata);
        if (!metadata.success) {
            throw new TenantPlacementError("UNAVAILABLE");
        }
        if (!isConfiguredTenantPlacement(environment, metadata.output.mobiusCloud.placement)) {
            throw new TenantPlacementError("UNAVAILABLE");
        }
        const current = counts.get(metadata.output.mobiusCloud.placement.d1ShardId);
        if (current !== undefined) {
            counts.set(metadata.output.mobiusCloud.placement.d1ShardId, current + 1);
        }
    }

    let selected = firstShard;
    for (const shard of remainingShards) {
        if ((counts.get(shard.id) ?? 0) < (counts.get(selected.id) ?? 0)) {
            selected = shard;
        }
    }
    return { d1ShardId: selected.id, r2BucketId: bucket.id, revision: 1 };
}

export function createTenantPlacementHandler(cx: {
    readonly gateways: { readonly organizations: OrganizationDirectory };
}): {
    readonly fetch: (request: Request) => Promise<Response>;
} {
    const { organizations } = cx.gateways;
    const executor = new SerialExecutor();
    return {
        fetch: async (request) => {
            try {
                if (request.method !== "POST") {
                    return Response.json(
                        {
                            error: {
                                code: "METHOD_NOT_ALLOWED",
                                message: "Method not allowed.",
                            },
                        },
                        { status: 405, headers: { Allow: "POST" } },
                    );
                }
                let value: unknown;
                try {
                    value = await request.json();
                } catch (cause) {
                    throw new TenantPlacementError("INVALID_INPUT", { cause });
                }
                const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
                if (new URL(request.url).pathname === "/resolve") {
                    const lookup = v.safeParse(placementLookupRequestSchema, value);
                    if (!lookup.success) {
                        throw new TenantPlacementError("INVALID_INPUT");
                    }
                    const organization = await organizations.get(lookup.output.organizationId, signal);
                    signal.throwIfAborted();
                    if (organization === null) {
                        return Response.json(
                            { error: { code: "NOT_FOUND", message: "Placement not found." } },
                            { status: 404 },
                        );
                    }
                    const envelope = v.safeParse(metadataEnvelopeSchema, organization.publicMetadata);
                    if (!envelope.success || envelope.output.mobiusCloud?.placement === undefined) {
                        throw new TenantPlacementError("UNAVAILABLE");
                    }
                    const metadata = v.safeParse(tenantPlacementMetadataSchema, organization.publicMetadata);
                    if (
                        !metadata.success ||
                        !isConfiguredTenantPlacement(lookup.output.environment, metadata.output.mobiusCloud.placement)
                    ) {
                        throw new TenantPlacementError("UNAVAILABLE");
                    }
                    return Response.json(
                        { placement: metadata.output.mobiusCloud.placement },
                        { headers: { "Cache-Control": "no-store" } },
                    );
                }
                const parsed = v.safeParse(allocationRequestSchema, value);
                if (!parsed.success) {
                    throw new TenantPlacementError("INVALID_INPUT");
                }
                return await executor.run(async () => {
                    const existing = await organizations.list(signal);
                    signal.throwIfAborted();
                    const placement = selectPlacement(parsed.output.environment, parsed.output.region, existing);
                    const created = await organizations.create(
                        {
                            createdBy: parsed.output.userId,
                            name: parsed.output.name,
                            publicMetadata: { mobiusCloud: { placement } },
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    console.info(
                        JSON.stringify({
                            audit: "tenant.created",
                            d1ShardId: placement.d1ShardId,
                            organizationId: created.id,
                            r2BucketId: placement.r2BucketId,
                            revision: placement.revision,
                        }),
                    );
                    return Response.json(
                        { canDelete: created.canDelete, id: created.id, name: created.name },
                        { status: 201, headers: { "Cache-Control": "no-store" } },
                    );
                }, signal);
            } catch (cause) {
                if (request.signal.aborted) {
                    throw request.signal.reason;
                }
                const code = cause instanceof TenantPlacementError ? cause.code : "UNAVAILABLE";
                return Response.json(
                    {
                        error: {
                            code,
                            message:
                                code === "INVALID_INPUT"
                                    ? "Enter a valid workspace name."
                                    : "Workspace creation is temporarily unavailable.",
                        },
                    },
                    { status: code === "INVALID_INPUT" ? 400 : 503 },
                );
            }
        },
    };
}
