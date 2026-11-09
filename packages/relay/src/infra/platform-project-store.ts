import type { ProjectStore, ProjectStoreResolver } from "@morty-build/relay-core/contracts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";

/** The Platform's operations on one Project's storage, beside the Relay's. The Account Durable Object owns both. */
export interface PlatformProjectStore extends ProjectStore {
    /** Records a Platform audit event; recording the same event again has no effect. */
    readonly recordAudit: (audit: PlatformAuditRecord, signal: AbortSignal) => Promise<void>;
    readonly listAuditEvents: (limit: number, signal: AbortSignal) => Promise<readonly ProjectAuditRow[]>;
}

export interface PlatformProjectStores extends ProjectStoreResolver {
    readonly forProject: (accountId: string) => PlatformProjectStore;
}
