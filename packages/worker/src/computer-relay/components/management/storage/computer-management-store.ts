import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { RelayAuditRecord } from "../../../../contracts/relay/relay-records.ts";
import type { ComputerRelayStore } from "./computer-relay-store.ts";

/** Audit and identity operations in the owning ComputerRelay storage. */
export interface ComputerManagementStore extends ComputerRelayStore {
    /** Records a Relay audit event; recording the same event again has no effect. */
    readonly recordAudit: (audit: RelayAuditRecord, signal: AbortSignal) => Promise<void>;
    /**
     * Whether `holder`'s access to the computer holds now, read from the computer's identities. A Session credential
     * carrying that access is issued and honored only while it does.
     */
    readonly holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>;
}
