import type { ComputerIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type {
    ComputerPairingDetails,
    ComputerPairingRequestRow,
    ComputerPairingStatusRow,
    PairedComputerRow,
    PairingClaimRow,
    PairingScopeRow,
    RuntimeCredentialRotation,
} from "../entity/pairing/pairing-records.ts";

export interface RequestRuntimePairing {
    readonly computerId: string;
    readonly codeHash: string;
    readonly pollHash: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
    readonly rejectionAuditId: string;
}

/** The pairing request stored under the idempotency key, or the quota that refused a new one. */
export type RuntimePairingRequest =
    | { readonly kind: "created" }
    | { readonly kind: "existing"; readonly request: ComputerPairingRequestRow }
    | { readonly kind: "quota_exceeded" };

export interface ClaimPairing {
    readonly computerId: string;
    readonly codeHash: string;
    readonly daemonHash: string;
    readonly now: number;
    readonly machineName: string;
    readonly workspaceName: string;
    readonly agents: string;
    readonly auditId: string;
    readonly rejectionAuditId: string;
}

export interface RevokeRuntime {
    readonly computerId: string;
    readonly now: number;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
}

/**
 * The operations on one Computer's storage. The Computer's storage owner executes each operation as one unit, so the
 * preconditions it checks and the writes it makes are evaluated together; no caller composes queries against Computer
 * tables. A null or false result means the precondition did not hold and nothing was written.
 */
export interface ComputerStore {
    readonly updateAgentCatalog: (
        computerId: string,
        tokenHash: string,
        agents: string,
        signal: AbortSignal,
    ) => Promise<boolean>;
    /** The pairing generation whose daemon may act for the computer now; null while none may. */
    readonly readActiveGeneration: (computerId: string, signal: AbortSignal) => Promise<number | null>;
    readonly readRuntime: (computerId: string, signal: AbortSignal) => Promise<ComputerPairingStatusRow | null>;
    readonly listRuntimes: (signal: AbortSignal) => Promise<readonly PairedComputerRow[]>;
    /**
     * Returns the pairing request created under the idempotency key, or creates one within the Runtime quota. A
     * refused request is audited.
     */
    readonly requestRuntimePairing: (
        value: RequestRuntimePairing,
        signal: AbortSignal,
    ) => Promise<RuntimePairingRequest>;
    readonly readRuntimePairing: (computerId: string, signal: AbortSignal) => Promise<ComputerPairingDetails | null>;
    readonly readPairingCode: (codeHash: string, signal: AbortSignal) => Promise<PairingClaimRow | null>;
    /**
     * Claims a pairing for a daemon. A replay with the credential it committed succeeds while the pairing is
     * unexpired; any other failed claim is audited and returns false.
     */
    readonly claimPairing: (value: ClaimPairing, signal: AbortSignal) => Promise<boolean>;
    /**
     * Revokes a Runtime and returns its committed revocation; null when the Computer has no such Runtime. Ending its
     * pairing generation also ends the Session credentials issued under it.
     */
    readonly revokeRuntime: (value: RevokeRuntime, signal: AbortSignal) => Promise<ComputerPairingStatusRow | null>;
    /** The Projects whose stored credential matches; the caller decides what a match authorizes. */
    readonly findCredential: (
        credential: ComputerIdentityCredential,
        signal: AbortSignal,
    ) => Promise<readonly PairingScopeRow[]>;
    readonly rotateRuntimeCredential: (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ) => Promise<RuntimeCredentialRotation>;
}

export interface ComputerStoreResolver {
    readonly resolve: (computerId: string) => ComputerStore;
}
