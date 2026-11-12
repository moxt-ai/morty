export interface PairingScopeRow {
    readonly computer_id: string;
}

export interface RevokeComputer {
    readonly computerId: string;
    readonly now: number;
}

/** What presenting a Computer credential with its successor found, after any rotation it caused. */
export type ComputerCredentialRotation =
    /** The successor authenticates now: rotated just now, or by an earlier attempt whose reply was lost. */
    | { readonly kind: "rotated"; readonly computer: PairingScopeRow }
    /** A credential an earlier rotation retired, presented with another successor: a copy is in use elsewhere. */
    | { readonly kind: "reused"; readonly computer: PairingScopeRow }
    /** A credential of a Computer whose access has ended. */
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

interface ComputerRegistrationRow {
    readonly claimed_at: number;
    readonly agents_json: string;
    readonly computer_name: string;
    readonly workspace_name: string;
}

export interface ComputerDirectoryRow extends PairingScopeRow, ComputerRegistrationRow {}

export interface ComputerPairingDirectoryRow extends PairingScopeRow {
    readonly revoked_at: number | null;
    readonly registration: ComputerRegistrationRow | null;
}

export interface PairingComputerRow extends ComputerPairingDirectoryRow {
    readonly expires_at: number;
}

export interface PairingClaimRow extends PairingComputerRow {
    readonly poll_token_hash: string;
}

export interface ComputerPairingRow extends PairingScopeRow {
    readonly pairing_code_hash: string;
    readonly poll_token_hash: string;
    readonly expires_at: number;
    readonly created_by_owner_credential_id: string | null;
}
