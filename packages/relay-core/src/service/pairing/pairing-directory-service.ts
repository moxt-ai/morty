import { isComputerCredentialSuccessor } from "@morty-build/client/protocol";
import {
    PROJECT_HOST_PERMISSIONS,
    type ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectPermission,
} from "../../entity/authentication/project-authentication.ts";
import type { ProjectAccessAuthorizer } from "../../entity/authentication/project-authorization.ts";
import type { ComputerScope } from "../../entity/do/session.ts";
import { computerRevokedAt, projectComputerPairingStatus } from "../../entity/pairing/computer-pairing-state.ts";
import type { AgentDescriptor, ClaimedPairing } from "../../entity/pairing/pairing.ts";
import {
    ChannelDescriptor,
    CreatedComputerPairing,
    hashPairingCredential,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    parseAgents,
    RevokedProjectComputer,
    validateIdentifier,
    validateToken,
} from "../../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { ComputerPairingRow } from "../../entity/pairing/pairing-records.ts";
import type { MachineAccountDirectory } from "../../infra/machine-account-directory.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type { ProjectStore } from "../../infra/project-store.ts";
import { deriveComputerDaemonToken, deriveComputerPairingSecrets } from "./computer-pairing-secrets.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";
import type { PairingOperations } from "./pairing-operations.ts";

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

    readonly rotateComputerCredential: PairingOperations["rotateComputerCredential"] = async (
        token,
        successor,
        signal,
    ) => {
        signal.throwIfAborted();
        const current = validateToken(token);
        if (!isComputerCredentialSuccessor(current, successor)) {
            throw new PairingDirectoryError("unauthorized", "A valid Computer credential successor is required");
        }
        const rotation = await this.#cx.services.identities.rotateComputer(
            await hashPairingCredential(current),
            await hashPairingCredential(successor),
            signal,
        );
        if (rotation.kind !== "reused") {
            return rotation;
        }
        // Only the daemon that saved a successor can present the retired credential with it. Another successor means
        // a copy of the credential connected first, so neither copy may keep the Computer.
        const storage = await this.projectStorage(rotation.access, signal);
        await storage.revokeComputer(
            {
                computerId: rotation.access.computerId,
                now: Date.now(),
                actorKind: "relay",
                actorId: "computer_credential_reuse",
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        return rotation;
    };

    readonly authorizeProject: PairingOperations["authorizeProject"] = async (computerId, permission, signal) =>
        await this.#cx.services.projectAuthentication.authorizeProject(computerId, permission, signal);

    readonly authorizePairedHost: PairingOperations["authorizePairedHost"] = async (computerId, signal) => {
        const access = await this.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        if (!PROJECT_HOST_PERMISSIONS.every(access.permits)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential does not grant the permissions a Computer host connection needs",
            );
        }
        const storage = await this.projectStorage(access.scope, signal);
        const computer = await this.readActivePairing(storage, computerId, signal);
        return { computerId: computer.computerId };
    };

    readonly authorizePairing: PairingOperations["authorizePairing"] = async (computerId, permission, signal) => {
        const access = await this.authorizeProject(computerId, permission, signal);
        const storage = await this.projectStorage(access.scope, signal);
        return await this.readActivePairing(storage, computerId, signal);
    };

    private readonly readActivePairing = async (storage: ProjectStore, computerId: string, signal: AbortSignal) => {
        const row = await storage.readComputer(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        if (computerRevokedAt(row.revoked_at) !== null || row.registration === null) {
            throw new PairingDirectoryError("computer_unavailable", "The selected Computer is unavailable");
        }
        return { computerId: row.computer_id };
    };

    private readonly decodeCreatedComputerPairing = async (
        row: ComputerPairingRow,
        owner: ProjectAccessContext,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
        if (row.computer_id !== owner.computerId || row.created_by_owner_credential_id !== owner.actor.actorId) {
            throw new PairingDirectoryError(
                "idempotency_conflict",
                "The Computer pairing idempotency key belongs to another authorized request",
            );
        }
        const secrets = await deriveComputerPairingSecrets(pairingKey, owner.computerId, idempotencyKey);
        const codeHash = await hashPairingCredential(secrets.pairingCode);
        const pollHash = await hashPairingCredential(secrets.pollToken);
        signal.throwIfAborted();
        if (row.pairing_code_hash !== codeHash || row.poll_token_hash !== pollHash) {
            throw new PairingDirectoryError(
                "invalid_directory_record",
                "This pairing cannot be reused; reinstall Morty and create a new pairing",
            );
        }
        return new CreatedComputerPairing(
            new Date(row.expires_at).toISOString(),
            secrets.pairingCode,
            secrets.pollToken,
            row.computer_id,
        );
    };

    readonly createProjectComputerPairing: PairingOperations["createProjectComputerPairing"] = async (
        computerId,
        pairingKey,
        idempotencyKey,
        signal,
    ) => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.authorizeProject(normalizedComputerId, ProjectPermission.ComputerPair, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveComputerPairingSecrets(pairingKey, owner.computerId, normalizedKey);
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ProjectStore["requestComputerPairing"]>>;
        try {
            stored = await storage.requestComputerPairing(
                {
                    computerId,
                    codeHash: await hashPairingCredential(secrets.pairingCode),
                    pollHash: await hashPairingCredential(secrets.pollToken),
                    now,
                    expiresAt,
                    idempotencyKey: normalizedKey,
                    ownerId: owner.actor.actorId,
                    actorKind: owner.actor.kind,
                    actorId: owner.actor.actorId,
                    auditId: `rpa_${crypto.randomUUID()}`,
                    rejectionAuditId: `rpa_${crypto.randomUUID()}`,
                },
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError("directory_unavailable", "The Computer pairing could not be stored", {
                cause,
            });
        }
        switch (stored.kind) {
            case "existing":
                return this.decodeCreatedComputerPairing(stored.request, owner, pairingKey, normalizedKey, signal);
            case "quota_exceeded":
                throw new PairingDirectoryError(
                    "computer_quota_exceeded",
                    "This computer already has a daemon or pending pairing",
                );
            case "created":
                return new CreatedComputerPairing(
                    new Date(expiresAt).toISOString(),
                    secrets.pairingCode,
                    secrets.pollToken,
                    owner.computerId,
                );
        }
    };

    readonly readProjectComputerPairing: PairingOperations["readProjectComputerPairing"] = async (
        computerId,
        signal,
    ) => {
        const owner = await this.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.readComputerPairing(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Computer pairing request was not found");
        }
        return projectComputerPairingStatus(row, Date.now());
    };

    readonly revokeProjectComputer: PairingOperations["revokeProjectComputer"] = async (computerId, signal) => {
        const owner = await this.authorizeProject(computerId, ProjectPermission.ComputerRevoke, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.revokeComputer(
            {
                computerId: validateIdentifier(computerId, "computer_id"),
                now: Date.now(),
                actorKind: owner.actor.kind,
                actorId: owner.actor.actorId,
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        if (row === null) {
            throw new PairingDirectoryError("computer_not_found", "The Computer was not found");
        }
        const revokedAt = computerRevokedAt(row.revoked_at);
        if (revokedAt === null) {
            throw new PairingDirectoryError("invalid_directory_record", "The Computer revocation is invalid");
        }
        return new RevokedProjectComputer({ computerId: row.computer_id }, new Date(revokedAt).toISOString());
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
        const daemonToken = await deriveComputerDaemonToken(pairingCode, pairing.computer_id, pairing.poll_token_hash);
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

    readonly redeemComputerPairing: PairingOperations["redeemComputerPairing"] = async (
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

    readonly listProjectComputers: PairingOperations["listProjectComputers"] = async (computerId, signal) => {
        const access = await this.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const computers = await storage.listComputers(signal);
        return computers.map(
            (row) =>
                new ChannelDescriptor(
                    parseAgents(row.agents_json),
                    row.machine_name,
                    row.workspace_name,
                    row.computer_id,
                ),
        );
    };

    readonly isProjectComputerRevoked: PairingOperations["isProjectComputerRevoked"] = async (computerId, signal) => {
        const access = await this.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const row = await storage.readComputer(validateIdentifier(computerId, "computer_id"), signal);
        return row !== null && computerRevokedAt(row.revoked_at) !== null;
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
