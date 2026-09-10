import type { HumanPrincipal } from "./identity-service.ts";

export interface TenantContext {
    readonly tenantId: string;
}

export function humanTenant(principal: HumanPrincipal): TenantContext {
    return { tenantId: principal.tenantId };
}

export function tenantContext(tenantId: string): TenantContext {
    return { tenantId };
}
