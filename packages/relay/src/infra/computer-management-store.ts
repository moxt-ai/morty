import type { ProjectStore, ProjectStoreResolver } from "@morty-build/relay-core/contracts";
import type { ProjectAuditRow, RelayAuditRecord } from "../entity/relay-records.ts";

/** The Relay's operations on one Project's storage, beside the Relay's. The Account Durable Object owns both. */
export interface ComputerManagementStore extends ProjectStore {
    /** Records a Relay audit event; recording the same event again has no effect. */
    readonly recordAudit: (audit: RelayAuditRecord, signal: AbortSignal) => Promise<void>;
    readonly listAuditEvents: (limit: number, signal: AbortSignal) => Promise<readonly ProjectAuditRow[]>;
}

export interface ComputerManagementStores extends ProjectStoreResolver {
    readonly forProject: (computerId: string) => ComputerManagementStore;
}
