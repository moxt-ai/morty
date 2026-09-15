export interface TenantContext {
    readonly tenantId: string;
}

export function tenantContext(tenantId: string): TenantContext {
    return { tenantId };
}
