export interface PairingScopeRow {
    readonly computer_id: string;
}

/** What presenting a Runtime credential with its successor found, after any rotation it caused. */
export type RuntimeCredentialRotation =
    /** The successor authenticates now: rotated just now, or by an earlier attempt whose reply was lost. */
    | { readonly kind: "rotated"; readonly runtime: PairingScopeRow }
    /** A credential an earlier rotation retired, presented with another successor: a copy is in use elsewhere. */
    | { readonly kind: "reused"; readonly runtime: PairingScopeRow }
    /** A credential of a Runtime whose access has ended. */
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

interface RuntimeRegistrationRow {
    readonly claimed_at: number;
    readonly agents_json: string;
    readonly machine_name: string;
    readonly workspace_name: string;
}

export interface RuntimeChannelRow extends PairingScopeRow, RuntimeRegistrationRow {}

export interface RuntimeDirectoryRow extends PairingScopeRow {
    readonly revoked_at: number | null;
    readonly registration: RuntimeRegistrationRow | null;
}

export interface PairingChannelRow extends RuntimeDirectoryRow {
    readonly expires_at: number;
}

export interface PairingClaimRow extends PairingChannelRow {
    readonly poll_token_hash: string;
}

export interface RuntimePairingRow extends PairingScopeRow {
    readonly pairing_code_hash: string;
    readonly poll_token_hash: string;
    readonly expires_at: number;
    readonly created_by_owner_credential_id: string | null;
}

export interface RuntimePairingAudit {
    readonly auditId: string;
    readonly computerId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly action:
        | "runtime_pairing.requested"
        | "runtime_pairing.claimed"
        | "runtime_pairing.expired"
        | "runtime_pairing.revoked"
        | "runtime_pairing.rejected";
    readonly details: Readonly<Record<string, string>>;
    readonly recordedAt: number;
}
