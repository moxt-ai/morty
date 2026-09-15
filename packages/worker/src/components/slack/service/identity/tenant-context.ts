import type { TenantContext } from "../../entity/tenant-context";
import type { HumanPrincipal } from "./identity-service.ts";

export { type TenantContext, tenantContext } from "../../entity/tenant-context";

export function humanTenant(principal: HumanPrincipal): TenantContext {
    return { tenantId: principal.tenantId };
}
