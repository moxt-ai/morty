import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { ComputerStore, ComputerStoreResolver } from "@morty-build/relay-core/contracts";
import type { ComputerAuditRow, RelayAuditRecord } from "../entity/relay-records.ts";

/** The Relay's operations on one Computer's storage, beside the Relay's. The Account Durable Object owns both. */
export interface ComputerManagementStore extends ComputerStore {
    /** Records a Relay audit event; recording the same event again has no effect. */
    readonly recordAudit: (audit: RelayAuditRecord, signal: AbortSignal) => Promise<void>;
    readonly listAuditEvents: (limit: number, signal: AbortSignal) => Promise<readonly ComputerAuditRow[]>;
    /**
     * Whether `holder`'s access to the computer holds now, read from the computer's identities. A Session credential
     * carrying that access is issued and honored only while it does.
     */
    readonly holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>;
}

export interface ComputerManagementStores extends ComputerStoreResolver {
    readonly forComputer: (computerId: string) => ComputerManagementStore;
}
