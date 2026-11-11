import type {
    ComputerAccessContext,
    ProjectAccessContext,
    ProjectPermission,
} from "../../entity/authentication/project-authentication.ts";
import type {
    AgentDescriptor,
    ChannelDescriptor,
    ClaimedPairing,
    CreatedComputerPairing,
    PairingStatus,
    RevokedProjectComputer,
    VerifiedChannelAccess,
} from "../../entity/pairing/pairing.ts";
export interface PairingOperations {
    /**
     * Rotates a daemon credential to the successor the daemon saved. A reused credential has already ended the
     * Computer's access when this returns; the caller closes its connections.
     */
    readonly rotateComputerCredential: (
        token: string,
        successor: string,
        signal: AbortSignal,
    ) => Promise<
        { readonly kind: "rotated" | "reused"; readonly access: ComputerAccessContext } | { readonly kind: "revoked" }
    >;
    readonly authorizePairedHost: (computerId: string, signal: AbortSignal) => Promise<VerifiedChannelAccess>;
    readonly authorizeProject: (
        computerId: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
    readonly authorizePairing: (
        computerId: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<VerifiedChannelAccess>;
    // v1: reserve capacity atomically. The same Project/key/credential replays
    // the original identity, secrets, and deadline, including after expiration
    // or revocation. A failed response may follow a commit; retry the same key.
    readonly createProjectComputerPairing: (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => Promise<CreatedComputerPairing>;
    readonly listProjectComputers: (computerId: string, signal: AbortSignal) => Promise<readonly ChannelDescriptor[]>;
    /** Whether the Project's Computer was revoked; false for one the Project never had. */
    readonly isProjectComputerRevoked: (computerId: string, signal: AbortSignal) => Promise<boolean>;
    // Read-only v1 projection: revoked, claimed, expired, or pending, in that
    // order. Passing the deadline never expires an already registered Computer.
    readonly readProjectComputerPairing: (computerId: string, signal: AbortSignal) => Promise<PairingStatus>;
    // v1: one unrevoked, unexpired request can be consumed by one daemon. The
    // registration, credential, and audit commit together. Concurrent/repeated
    // claims fail; a lost successful response cannot replay the daemon secret.
    readonly redeemComputerPairing: (
        computerId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<ClaimedPairing>;
    // Revoke identity and channel credentials atomically, preserving the first
    // revocation timestamp. Retrying after a lost response or disconnect failure
    // is safe; an unclaimed identity can also be cancelled through this command.
    readonly revokeProjectComputer: (computerId: string, signal: AbortSignal) => Promise<RevokedProjectComputer>;
    /**
     * Records the daemon's Agent catalog. The daemon presents its credential with the successor it saved, if any:
     * while it saves a rotation its connection just made, the Relay already holds the successor as current.
     */
    readonly updateAgentCatalog: (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<void>;
}
