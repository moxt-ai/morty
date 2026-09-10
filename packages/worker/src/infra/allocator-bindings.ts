import * as v from "valibot";
import type { TenantPlacementAllocator } from "../do/tenant-placement-do.ts";
import { deploymentEnvironmentSchema } from "../entity/tenant-placement.ts";

export interface TenantCreationBindings {
    readonly DEPLOY_ENVIRONMENT: "staging" | "production";
    readonly TENANT_PLACEMENT_ALLOCATOR: DurableObjectNamespace<TenantPlacementAllocator>;
}

const tenantCreationBindingsSchema = v.pipe(
    v.object({
        DEPLOY_ENVIRONMENT: deploymentEnvironmentSchema,
        TENANT_PLACEMENT_ALLOCATOR: v.object({
            get: v.function(),
            idFromName: v.function(),
        }),
    }),
    v.readonly(),
);

export function hasTenantCreationBindings(bindings: unknown): bindings is TenantCreationBindings {
    return v.safeParse(tenantCreationBindingsSchema, bindings).success;
}
