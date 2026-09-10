import type { TenantContext } from "../service/identity/tenant-context";

export interface SlackAppDirectory {
    readonly find: (
        slackAppId: string,
        signal: AbortSignal,
    ) => Promise<{
        readonly tenant: TenantContext;
        readonly signingSecret: string;
    } | null>;
}
