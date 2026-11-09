import { isRuntimeCredentialSuccessor } from "@morty-build/client/protocol";
import {
    PROJECT_HOST_PERMISSIONS,
    type ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectPermission,
} from "../../entity/authentication/project-authentication.ts";
import { ComputerScope } from "../../entity/do/session.ts";
import type { AgentDescriptor, ClaimedPairing } from "../../entity/pairing/pairing.ts";
import {
    ACCESS_GRANT_LIFETIME_MILLISECONDS,
    ChannelDescriptor,
    ChannelHostCredential,
    CreatedBrowserCredential,
    CreatedRuntimePairing,
    createRandomToken,
    hashPairingCredential,
    LinkedChannelDevice,
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    ProjectCredentialHostAccess,
    parseAgents,
    RevokedProjectRuntime,
    VerifiedChannelAccess,
    validateIdentifier,
    validateToken,
} from "../../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { AuthorizedChannelRow, RuntimePairingRow } from "../../entity/pairing/pairing-records.ts";
import { projectRuntimePairingStatus, runtimeRevokedAt } from "../../entity/pairing/runtime-pairing-state.ts";
import type { ProjectAccessAuthorizer } from "../../gateway/project-access-authorizer.ts";
import type { MachineAccountDirectory } from "../../infra/machine-account-directory.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type { ProjectStore } from "../../infra/project-store.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { deriveRuntimeDaemonToken, deriveRuntimePairingSecrets } from "./runtime-pairing-secrets.ts";

export interface PairingDirectoryInfrastructure {
    readonly gateways: { readonly machineAccounts: MachineAccountDirectory };
    readonly storages: {
        readonly forProject: (project: ProjectStorageContext) => ProjectStore;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly services: {
        readonly identities: ComputerIdentityService;
        readonly projectAuthentication: ProjectAccessAuthorizer;
    };
}

export class PairingDirectoryService implements PairingOperations {
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly projectStorage = async (scope: ComputerScope, signal: AbortSignal) => {
        const project = await this.#cx.storages.projectDirectory.resolve(scope.computerId, signal);
        signal.throwIfAborted();
        if (project === null) {
            throw new PairingDirectoryError("unauthorized", "The Project is no longer active");
        }
        if (project.computerId !== scope.computerId) {
            throw new PairingDirectoryError("invalid_directory_record", "The Project storage locator is invalid");
        }
        return this.#cx.storages.forProject(project);
    };

    private readonly identityStorage = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        const project = await this.#cx.services.identities.authenticateProject(credential, signal);
        return this.#cx.storages.forProject(project);
    };

    private readonly readAuthorizedHost = async (
        computerId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow> => {
        signal.throwIfAborted();
        const tokenHash = await hashPairingCredential(validateToken(token));
        const storage = await this.identityStorage({ kind: "host", computerId, tokenHash }, signal);
        const row = await storage.authenticateHost(
            validateIdentifier(computerId, "computer_id"),
            tokenHash,
            Date.now(),
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        return row;
    };

    private readonly readAuthorizedOwner = async (computerId: string, token: string, signal: AbortSignal) => {
        const row = await this.readAuthorizedHost(computerId, token, signal);
        if (row.authority !== "owner") {
            throw new PairingDirectoryError(
                "owner_access_required",
                "Only the channel owner can manage linked devices",
            );
        }
        return row;
    };

    readonly rotateRuntimeCredential: PairingOperations["rotateRuntimeCredential"] = async (
        token,
        successor,
        signal,
    ) => {
        signal.throwIfAborted();
        const current = validateToken(token);
        if (!isRuntimeCredentialSuccessor(current, successor)) {
            throw new PairingDirectoryError("unauthorized", "A valid Runtime credential successor is required");
        }
        const rotation = await this.#cx.services.identities.rotateRuntime(
            await hashPairingCredential(current),
            await hashPairingCredential(successor),
            signal,
        );
        if (rotation.kind !== "reused") {
            return rotation;
        }
        // Only the daemon that saved a successor can present the retired credential with it. Another successor means
        // a copy of the credential connected first, so neither copy may keep the Runtime.
        const storage = await this.projectStorage(rotation.access.scope, signal);
        await storage.revokeRuntime(
            {
                computerId: rotation.access.computerId,
                ownerId: null,
                now: Date.now(),
                actorKind: "relay",
                actorId: "runtime_credential_reuse",
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        return rotation;
    };

    readonly authorizeHost: PairingOperations["authorizeHost"] = async (computerId, token, signal) => {
        const row = await this.readAuthorizedHost(computerId, token, signal);
        return new ChannelHostCredential(row.computer_id, row.credential_id);
    };

    readonly authorizeProject: PairingOperations["authorizeProject"] = async (computerId, token, permission, signal) =>
        await this.#cx.services.projectAuthentication.authorizeProject(computerId, token, permission, "", signal);

    readonly authorizePairedHost: PairingOperations["authorizePairedHost"] = async (computerId, token, signal) => {
        const access = await this.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        if (!PROJECT_HOST_PERMISSIONS.every(access.permits)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential does not grant the permissions a Runtime host connection needs",
            );
        }
        const storage = await this.projectStorage(access.scope, signal);
        const runtime = await this.readActivePairing(storage, computerId, signal);
        return new ProjectCredentialHostAccess(runtime.computerId, access.credentialId);
    };

    readonly authorizePairing: PairingOperations["authorizePairing"] = async (
        computerId,
        token,
        permission,
        signal,
    ) => {
        const access = await this.authorizeProject(computerId, token, permission, signal);
        const storage = await this.projectStorage(access.scope, signal);
        return await this.readActivePairing(storage, computerId, signal);
    };

    private readonly readActivePairing = async (storage: ProjectStore, computerId: string, signal: AbortSignal) => {
        const row = await storage.readRuntime(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        if (runtimeRevokedAt(row.revoked_at) !== null || row.registration === null) {
            throw new PairingDirectoryError("runtime_unavailable", "The selected Runtime is unavailable");
        }
        return new VerifiedChannelAccess(row.computer_id, parseAgents(row.registration.agents_json));
    };

    private readonly decodeCreatedRuntimePairing = async (
        row: RuntimePairingRow,
        owner: ProjectAccessContext,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
        if (row.computer_id !== owner.computerId || row.created_by_owner_credential_id !== owner.credentialId) {
            throw new PairingDirectoryError(
                "idempotency_conflict",
                "The Runtime pairing idempotency key belongs to another authorized request",
            );
        }
        const secrets = await deriveRuntimePairingSecrets(token, owner.computerId, idempotencyKey);
        const codeHash = await hashPairingCredential(secrets.pairingCode);
        const pollHash = await hashPairingCredential(secrets.pollToken);
        signal.throwIfAborted();
        if (row.pairing_code_hash !== codeHash || row.poll_token_hash !== pollHash) {
            throw new PairingDirectoryError(
                "invalid_directory_record",
                "This pairing cannot be reused; reinstall Morty and create a new pairing",
            );
        }
        return new CreatedRuntimePairing(
            new Date(row.expires_at).toISOString(),
            secrets.pairingCode,
            secrets.pollToken,
            row.computer_id,
        );
    };

    readonly createProjectRuntimePairing: PairingOperations["createProjectRuntimePairing"] = async (
        computerId,
        token,
        idempotencyKey,
        signal,
    ) => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.authorizeProject(normalizedComputerId, token, ProjectPermission.RuntimePair, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveRuntimePairingSecrets(token, owner.computerId, normalizedKey);
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ProjectStore["requestRuntimePairing"]>>;
        try {
            stored = await storage.requestRuntimePairing(
                {
                    computerId,
                    codeHash: await hashPairingCredential(secrets.pairingCode),
                    pollHash: await hashPairingCredential(secrets.pollToken),
                    now,
                    expiresAt,
                    idempotencyKey: normalizedKey,
                    ownerId: owner.credentialId,
                    actorKind: owner.actor.kind.value,
                    actorId: owner.actor.actorId,
                    auditId: `rpa_${crypto.randomUUID()}`,
                    rejectionAuditId: `rpa_${crypto.randomUUID()}`,
                },
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError("directory_unavailable", "The Runtime pairing could not be stored", {
                cause,
            });
        }
        switch (stored.kind) {
            case "existing":
                return this.decodeCreatedRuntimePairing(stored.request, owner, token, normalizedKey, signal);
            case "quota_exceeded":
                throw new PairingDirectoryError(
                    "runtime_quota_exceeded",
                    "This computer already has a daemon or pending pairing",
                );
            case "created":
                return new CreatedRuntimePairing(
                    new Date(expiresAt).toISOString(),
                    secrets.pairingCode,
                    secrets.pollToken,
                    owner.computerId,
                );
        }
    };

    readonly readProjectRuntimePairing: PairingOperations["readProjectRuntimePairing"] = async (
        computerId,
        token,
        signal,
    ) => {
        const owner = await this.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.readRuntimePairing(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Runtime pairing request was not found");
        }
        return projectRuntimePairingStatus(row, Date.now());
    };

    readonly revokeProjectRuntime: PairingOperations["revokeProjectRuntime"] = async (computerId, token, signal) => {
        const owner = await this.authorizeProject(computerId, token, ProjectPermission.RuntimeRevoke, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.revokeRuntime(
            {
                computerId: validateIdentifier(computerId, "computer_id"),
                ownerId: owner.credentialId,
                now: Date.now(),
                actorKind: owner.actor.kind.value,
                actorId: owner.actor.actorId,
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        const revokedAt = runtimeRevokedAt(row.revoked_at);
        if (revokedAt === null) {
            throw new PairingDirectoryError("invalid_directory_record", "The Runtime revocation is invalid");
        }
        return new RevokedProjectRuntime(
            new VerifiedChannelAccess(row.computer_id, []),
            new Date(revokedAt).toISOString(),
        );
    };

    private readonly redeemPairing = async (
        expectedComputerId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> => {
        signal.throwIfAborted();
        const codeHash = await hashPairingCredential(normalizePairingCode(pairingCode));
        const storage = await this.identityStorage({ kind: "pairing-code", codeHash }, signal);
        const pairing = await storage.readPairingCode(codeHash, signal);
        if (pairing === null || pairing.computer_id !== expectedComputerId) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        await this.#cx.gateways.machineAccounts.requireActiveAccount(pairing.computer_id, signal);
        const daemonToken = await deriveRuntimeDaemonToken(pairingCode, pairing.computer_id, pairing.poll_token_hash);
        const claimed = await storage.claimPairing(
            {
                computerId: pairing.computer_id,
                codeHash,
                daemonHash: await hashPairingCredential(daemonToken),
                now: Date.now(),
                machineName,
                workspaceName,
                agents: JSON.stringify(agents),
                auditId: `rpa_${crypto.randomUUID()}`,
                rejectionAuditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        if (!claimed) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        return { computerId: pairing.computer_id, daemonToken };
    };

    readonly redeemRuntimePairing: PairingOperations["redeemRuntimePairing"] = async (
        computerId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) =>
        await this.redeemPairing(
            validateIdentifier(computerId, "computer_id"),
            pairingCode,
            machineName,
            workspaceName,
            agents,
            signal,
        );

    readonly createChannelAccessGrant: PairingOperations["createChannelAccessGrant"] = async (
        computerId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(computerId, token, signal);
        const now = Date.now();
        const grantId = `grt_${createRandomToken(18)}`;
        const grantSecret = createRandomToken(32);
        const expiresAt = now + ACCESS_GRANT_LIFETIME_MILLISECONDS;
        const storage = await this.projectStorage(new ComputerScope(owner.computer_id), signal);
        const created = await storage.createAccessGrant(
            {
                grantId,
                computerId: owner.computer_id,
                secretHash: await hashPairingCredential(grantSecret),
                ownerCredentialId: owner.credential_id,
                now,
                expiresAt,
            },
            signal,
        );
        if (!created) {
            throw new PairingDirectoryError("directory_unavailable", "The access grant was not stored");
        }
        return { expiresAt: new Date(expiresAt).toISOString(), grantId, grantSecret };
    };

    readonly createBrowserCredential: PairingOperations["createBrowserCredential"] = async (
        computerId,
        token,
        lifetimeMilliseconds,
        signal,
    ) => {
        if (
            !Number.isSafeInteger(lifetimeMilliseconds) ||
            lifetimeMilliseconds < MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS ||
            lifetimeMilliseconds > MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS
        ) {
            throw new PairingDirectoryError("invalid_request", "The browser credential lifetime is invalid");
        }
        const owner = await this.authorizeProject(computerId, token, ProjectPermission.OwnerCredentialsManage, signal);
        const now = Date.now();
        const expiresAt = now + lifetimeMilliseconds;
        const credentialId = `bcr_${createRandomToken(18)}`;
        const browserToken = createRandomToken(32);
        const storage = await this.projectStorage(owner.scope, signal);
        const created = await storage.createBrowserCredential(
            {
                credentialId,
                tokenHash: await hashPairingCredential(browserToken),
                ownerCredentialId: owner.credentialId,
                now,
                expiresAt,
            },
            signal,
        );
        if (!created) {
            throw new PairingDirectoryError("directory_unavailable", "The browser credential was not stored");
        }
        return new CreatedBrowserCredential(
            credentialId,
            new Date(expiresAt).toISOString(),
            owner.computerId,
            browserToken,
        );
    };

    readonly listLinkedChannelDevices: PairingOperations["listLinkedChannelDevices"] = async (
        computerId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(computerId, token, signal);
        const storage = await this.projectStorage(new ComputerScope(owner.computer_id), signal);
        const devices = await storage.listLinkedDevices(owner.computer_id, signal);
        return devices.map(
            (row) =>
                new LinkedChannelDevice(
                    row.credential_id,
                    new Date(row.created_at).toISOString(),
                    new Date(row.last_used_at).toISOString(),
                ),
        );
    };

    readonly listProjectRuntimes: PairingOperations["listProjectRuntimes"] = async (computerId, token, signal) => {
        const access = await this.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtimes = await storage.listRuntimes(signal);
        return runtimes.map(
            (row) =>
                new ChannelDescriptor(
                    parseAgents(row.agents_json),
                    row.machine_name,
                    row.workspace_name,
                    row.computer_id,
                ),
        );
    };

    readonly isProjectRuntimeRevoked: PairingOperations["isProjectRuntimeRevoked"] = async (
        computerId,
        token,
        signal,
    ) => {
        const access = await this.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const row = await storage.readRuntime(validateIdentifier(computerId, "computer_id"), signal);
        return row !== null && runtimeRevokedAt(row.revoked_at) !== null;
    };

    readonly readChannel: PairingOperations["readChannel"] = async (computerId, token, signal) => {
        const access = await this.readAuthorizedHost(computerId, token, signal);
        const storage = await this.projectStorage(new ComputerScope(access.computer_id), signal);
        const row = await storage.readChannel(access.computer_id, signal);
        if (row === null) {
            throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
        }
        if (row.computer_id !== computerId) {
            throw new PairingDirectoryError("invalid_directory_record", "The channel directory is invalid");
        }
        return new ChannelDescriptor(
            parseAgents(row.agents_json),
            row.machine_name,
            row.workspace_name,
            row.computer_id,
        );
    };

    readonly redeemChannelAccessGrant: PairingOperations["redeemChannelAccessGrant"] = async (
        computerId,
        grantId,
        grantSecret,
        signal,
    ) => {
        signal.throwIfAborted();
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedGrantId = validateIdentifier(grantId, "grant_id");
        const secretHash = await hashPairingCredential(validateToken(grantSecret));
        const now = Date.now();
        const credentialId = `hcr_${createRandomToken(18)}`;
        const hostToken = createRandomToken(32);
        const storage = await this.identityStorage({ kind: "grant", computerId, grantId, secretHash }, signal);
        const redemption = await storage.redeemAccessGrant(
            {
                computerId: normalizedComputerId,
                grantId: normalizedGrantId,
                secretHash,
                credentialId,
                tokenHash: await hashPairingCredential(hostToken),
                now,
            },
            signal,
        );
        switch (redemption.kind) {
            case "redeemed":
                return { hostToken, computerId: redemption.computerId };
            case "invalid":
                throw new PairingDirectoryError("access_grant_invalid", "The access link is invalid");
            case "already_redeemed":
                throw new PairingDirectoryError("access_grant_redeemed", "The access link has already been used");
            case "runtime_revoked":
                throw new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
            case "expired":
                throw new PairingDirectoryError("access_grant_expired", "The access link has expired");
            case "not_redeemed":
                throw new PairingDirectoryError("directory_unavailable", "The access grant could not be redeemed");
            case "channel_missing":
                throw new PairingDirectoryError(
                    "invalid_directory_record",
                    "The redeemed channel directory is invalid",
                );
        }
    };

    readonly revokeLinkedChannelDevice: PairingOperations["revokeLinkedChannelDevice"] = async (
        computerId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.readAuthorizedOwner(computerId, token, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.projectStorage(new ComputerScope(owner.computer_id), signal);
        if (!(await storage.revokeLinkedDevice(owner.computer_id, normalizedCredentialId, Date.now(), signal))) {
            throw new PairingDirectoryError("linked_device_not_found", "The linked device was not found");
        }
        return new ChannelHostCredential(owner.computer_id, normalizedCredentialId);
    };

    readonly revokeBrowserCredential: PairingOperations["revokeBrowserCredential"] = async (
        computerId,
        credentialId,
        token,
        signal,
    ) => {
        const owner = await this.authorizeProject(computerId, token, ProjectPermission.OwnerCredentialsManage, signal);
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const storage = await this.projectStorage(owner.scope, signal);
        if (!(await storage.revokeBrowserCredential(normalizedCredentialId, Date.now(), signal))) {
            throw new PairingDirectoryError("browser_credential_not_found", "The browser credential was not found");
        }
    };

    readonly updateAgentCatalog: PairingOperations["updateAgentCatalog"] = async (
        computerId,
        token,
        successor,
        agents,
        signal,
    ) => {
        signal.throwIfAborted();
        // Whichever presented credential the Relay holds as current authorizes; holding it is the proof.
        for (const presented of successor === null ? [token] : [token, successor]) {
            const tokenHash = await hashPairingCredential(validateToken(presented));
            let storage: ProjectStore;
            try {
                storage = await this.identityStorage({ kind: "daemon", computerId, tokenHash }, signal);
            } catch (cause) {
                if (cause instanceof PairingDirectoryError && cause.code === "unauthorized") {
                    continue;
                }
                throw cause;
            }
            if (await storage.updateAgentCatalog(computerId, tokenHash, JSON.stringify(agents), signal)) {
                return;
            }
        }
        throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
    };
}
