import type {
    ProjectAccessContext,
    ProjectPermission,
    RuntimeAccessContext,
} from "../../entity/authentication/project-authentication.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type {
    AgentDescriptor,
    ChannelDescriptor,
    ChannelHostCredential,
    ClaimedPairing,
    CreatedBrowserCredential,
    CreatedChannelAccessGrant,
    CreatedRuntimePairing,
    LinkedChannelDevice,
    PairingStatus,
    ProjectCredentialHostAccess,
    RedeemedChannelAccessGrant,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
} from "../../entity/pairing/pairing.ts";
export interface PairingOperations {
    /**
     * Rotates a daemon credential to the successor the daemon saved. A reused credential has already ended the
     * Runtime's access when this returns; the caller closes its connections.
     */
    readonly rotateRuntimeCredential: (
        token: string,
        successor: string,
        signal: AbortSignal,
    ) => Promise<
        { readonly kind: "rotated" | "reused"; readonly access: RuntimeAccessContext } | { readonly kind: "revoked" }
    >;
    readonly authorizeHost: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelHostCredential>;
    readonly authorizeProjectRuntimeHost: (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<ProjectCredentialHostAccess>;
    readonly authorizeProject: (
        projectId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
    readonly authorizeProjectRuntime: (
        projectId: string,
        runtimeId: string,
        token: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<VerifiedChannelAccess>;
    readonly authorizeProjectScopeRuntime: (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => Promise<VerifiedChannelAccess>;
    readonly createChannelAccessGrant: (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<CreatedChannelAccessGrant>;
    readonly createBrowserCredential: (
        projectId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<CreatedBrowserCredential>;
    // v1: reserve capacity atomically. The same Project/key/credential replays
    // the original identity, secrets, and deadline, including after expiration
    // or revocation. A failed response may follow a commit; retry the same key.
    readonly createProjectRuntimePairing: (
        projectId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => Promise<CreatedRuntimePairing>;
    readonly listLinkedChannelDevices: (
        channelId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<readonly LinkedChannelDevice[]>;
    readonly listProjectRuntimes: (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<readonly ChannelDescriptor[]>;
    /** Whether the Project's Runtime was revoked; false for one the Project never had. */
    readonly isProjectRuntimeRevoked: (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly readChannel: (channelId: string, token: string, signal: AbortSignal) => Promise<ChannelDescriptor>;
    // Read-only v1 projection: revoked, claimed, expired, or pending, in that
    // order. Passing the deadline never expires an already registered Runtime.
    readonly readProjectRuntimePairing: (
        projectId: string,
        pairingId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<PairingStatus>;
    // v1: one unrevoked, unexpired request can be consumed by one daemon. The
    // registration, credential, and audit commit together. Concurrent/repeated
    // claims fail; a lost successful response cannot replay the daemon secret.
    readonly redeemRuntimePairing: (
        pairingId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<ClaimedPairing>;
    readonly redeemChannelAccessGrant: (
        channelId: string,
        grantId: string,
        grantSecret: string,
        signal: AbortSignal,
    ) => Promise<RedeemedChannelAccessGrant>;
    readonly revokeLinkedChannelDevice: (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<ChannelHostCredential>;
    readonly revokeBrowserCredential: (
        projectId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<void>;
    // Revoke identity and channel credentials atomically, preserving the first
    // revocation timestamp. Retrying after a lost response or disconnect failure
    // is safe; an unclaimed identity can also be cancelled through this command.
    readonly revokeProjectRuntime: (
        projectId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => Promise<RevokedProjectRuntime>;
    /**
     * Records the daemon's Agent catalog. The daemon presents its credential with the successor it saved, if any:
     * while it saves a rotation its connection just made, the Relay already holds the successor as current.
     */
    readonly updateAgentCatalog: (
        channelId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => Promise<void>;
}
