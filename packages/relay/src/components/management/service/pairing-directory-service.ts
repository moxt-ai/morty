import { isRuntimeCredentialSuccessor } from "@morty-build/client/protocol";
import type { ComputerScope } from "../../runtime/entity/session.ts";
import { projectComputerPairingStatus, runtimeRevokedAt } from "../entity/computer-pairing-state.ts";
import type { AgentDescriptor, ClaimedPairing, PairingStatus, VerifiedComputerAccess } from "../entity/pairing.ts";
import {
    ComputerDescriptor,
    CreatedRuntimePairing,
    hashPairingCredential,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    parseAgents,
    RevokedProjectRuntime,
    validateIdentifier,
    validateToken,
} from "../entity/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing-identity.ts";
import type { RuntimePairingRow } from "../entity/pairing-records.ts";
import {
    PROJECT_HOST_PERMISSIONS,
    type ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectPermission,
} from "../entity/project-authentication.ts";
import type { ProjectStorageContext } from "../entity/project-storage-context.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { ComputerManagementService } from "./computer-management-service.ts";
import type { ComputerManagementStorageDirectory } from "./computer-management-storage-directory.ts";
import { deriveRuntimeDaemonToken, deriveRuntimePairingSecrets } from "./computer-pairing-secrets.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";

export interface PairingDirectoryInfrastructure {
    readonly storages: {
        readonly forProject: (project: ProjectStorageContext) => ComputerRelayStore;
    };
    readonly services: {
        readonly identities: ComputerIdentityService;
        readonly projectAuthentication: Pick<ComputerManagementService, "authorizeProject">;
        readonly machineAccounts: Pick<ComputerManagementService, "requireActiveAccount">;
        readonly projects: Pick<ComputerManagementStorageDirectory, "resolve">;
    };
}

export class PairingDirectoryService {
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly projectStorage = async (scope: ComputerScope, signal: AbortSignal) => {
        const project = await this.#cx.services.projects.resolve(scope.computerId, signal);
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

    readonly rotateRuntimeCredential = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
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
        const storage = await this.projectStorage(rotation.access, signal);
        await storage.revokeRuntime(
            {
                computerId: rotation.access.computerId,
                now: Date.now(),
                actorKind: "relay",
                actorId: "runtime_credential_reuse",
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            signal,
        );
        return rotation;
    };

    readonly authorizeProject = async (
        computerId: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> =>
        await this.#cx.services.projectAuthentication.authorizeProject(computerId, permission, signal);

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal): Promise<VerifiedComputerAccess> => {
        const access = await this.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        if (!PROJECT_HOST_PERMISSIONS.every(access.permits)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential does not grant the permissions a Runtime host connection needs",
            );
        }
        const storage = await this.projectStorage(access.scope, signal);
        const runtime = await this.readActivePairing(storage, computerId, signal);
        return { computerId: runtime.computerId };
    };

    readonly authorizePairing = async (
        computerId: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<VerifiedComputerAccess> => {
        const access = await this.authorizeProject(computerId, permission, signal);
        const storage = await this.projectStorage(access.scope, signal);
        return await this.readActivePairing(storage, computerId, signal);
    };

    private readonly readActivePairing = async (
        storage: ComputerRelayStore,
        computerId: string,
        signal: AbortSignal,
    ) => {
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
        return { computerId: row.computer_id };
    };

    private readonly decodeCreatedRuntimePairing = async (
        row: RuntimePairingRow,
        owner: ProjectAccessContext,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
        if (row.computer_id !== owner.computerId || row.created_by_owner_credential_id !== owner.actor.actorId) {
            throw new PairingDirectoryError(
                "idempotency_conflict",
                "The Runtime pairing idempotency key belongs to another authorized request",
            );
        }
        const secrets = await deriveRuntimePairingSecrets(pairingKey, owner.computerId, idempotencyKey);
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

    /** Replays retain the original identity, secrets and deadline; retries keep the same key after an ambiguous failure. */
    readonly createProjectRuntimePairing = async (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedRuntimePairing> => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.authorizeProject(normalizedComputerId, ProjectPermission.RuntimePair, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveRuntimePairingSecrets(pairingKey, owner.computerId, normalizedKey);
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ComputerRelayStore["requestRuntimePairing"]>>;
        try {
            stored = await storage.requestRuntimePairing(
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
            throw new PairingDirectoryError("directory_unavailable", "The Runtime pairing could not be stored", {
                cause,
            });
        }
        switch (stored.kind) {
            case "existing":
                return this.decodeCreatedRuntimePairing(stored.request, owner, pairingKey, normalizedKey, signal);
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

    readonly readProjectRuntimePairing = async (computerId: string, signal: AbortSignal): Promise<PairingStatus> => {
        const owner = await this.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.readRuntimePairing(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Runtime pairing request was not found");
        }
        return projectComputerPairingStatus(row, Date.now());
    };

    readonly revokeProjectRuntime = async (computerId: string, signal: AbortSignal): Promise<RevokedProjectRuntime> => {
        const owner = await this.authorizeProject(computerId, ProjectPermission.RuntimeRevoke, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.revokeRuntime(
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
            throw new PairingDirectoryError("runtime_not_found", "The Runtime was not found");
        }
        const revokedAt = runtimeRevokedAt(row.revoked_at);
        if (revokedAt === null) {
            throw new PairingDirectoryError("invalid_directory_record", "The Runtime revocation is invalid");
        }
        return new RevokedProjectRuntime({ computerId: row.computer_id }, new Date(revokedAt).toISOString());
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
        await this.#cx.services.machineAccounts.requireActiveAccount(pairing.computer_id, signal);
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

    readonly redeemRuntimePairing = async (
        computerId: string,
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> =>
        await this.redeemPairing(
            validateIdentifier(computerId, "computer_id"),
            pairingCode,
            machineName,
            workspaceName,
            agents,
            signal,
        );

    readonly listProjectRuntimes = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<readonly ComputerDescriptor[]> => {
        const access = await this.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtimes = await storage.listRuntimes(signal);
        return runtimes.map(
            (row) =>
                new ComputerDescriptor(
                    parseAgents(row.agents_json),
                    row.machine_name,
                    row.workspace_name,
                    row.computer_id,
                ),
        );
    };

    readonly isProjectRuntimeRevoked = async (computerId: string, signal: AbortSignal): Promise<boolean> => {
        const access = await this.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const row = await storage.readRuntime(validateIdentifier(computerId, "computer_id"), signal);
        return row !== null && runtimeRevokedAt(row.revoked_at) !== null;
    };

    readonly updateAgentCatalog = async (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        // Whichever presented credential the Relay holds as current authorizes; holding it is the proof.
        for (const presented of successor === null ? [token] : [token, successor]) {
            const tokenHash = await hashPairingCredential(validateToken(presented));
            let storage: ComputerRelayStore;
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
