import type { TenantContext } from "../entity/tenant-context";

export interface SlackAppDirectory {
    readonly find: (
        slackAppId: string,
        signal: AbortSignal,
    ) => Promise<{
        readonly tenant: TenantContext;
        readonly signingSecret: string;
    } | null>;
}
