import { isComputerCredentialSuccessor } from "@morty-build/client/protocol";
import { computerRevokedAt, projectComputerPairingStatus } from "../../../../contracts/relay/computer-pairing-state.ts";
import type {
    AgentDescriptor,
    ClaimedPairing,
    PairingStatus,
    VerifiedComputerAccess,
} from "../../../../contracts/relay/pairing.ts";
import {
    ComputerDescriptor,
    CreatedComputerPairing,
    hashPairingCredential,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    parseAgents,
    validateIdentifier,
    validateToken,
} from "../../../../contracts/relay/pairing.ts";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import type { ComputerPairingRow } from "../../../../contracts/relay/pairing-records.ts";
import type { ProjectAccessContext } from "../../../../contracts/relay/project-authentication.ts";
import type { ComputerScope } from "../../../../contracts/relay/session.ts";
import type { ComputerManagementService } from "../../../../directory/service/computer-management-service.ts";
import type { ComputerManagementStorageDirectory } from "../../../../directory/service/computer-management-storage-directory.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import { deriveComputerDaemonToken, deriveComputerPairingSecrets } from "./computer-pairing-secrets.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";

export interface PairingDirectoryInfrastructure {
    readonly computerId: string;
    readonly store: ComputerRelayStore;
    readonly services: {
        readonly identities: ComputerIdentityService;
        readonly projectAuthentication: Pick<ComputerManagementService, "authorizeProject">;
        readonly computerAccounts: Pick<ComputerManagementService, "requireActiveAccount">;
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
        if (project.computerId !== scope.computerId || project.computerId !== this.#cx.computerId) {
            throw new PairingDirectoryError("invalid_directory_record", "The Project storage locator is invalid");
        }
        return this.#cx.store;
    };

    private readonly identityStorage = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        const project = await this.#cx.services.identities.authenticateProject(credential, signal);
        if (project.computerId !== this.#cx.computerId) {
            throw new PairingDirectoryError("invalid_directory_record", "The Project storage locator is invalid");
        }
        return this.#cx.store;
    };

    readonly rotateComputerCredential = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
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

    readonly authorizeProject = async (computerId: string, signal: AbortSignal): Promise<ProjectAccessContext> =>
        await this.#cx.services.projectAuthentication.authorizeProject(computerId, signal);

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal): Promise<VerifiedComputerAccess> => {
        const access = await this.authorizeProject(computerId, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtime = await this.readActivePairing(storage, computerId, signal);
        return { computerId: runtime.computerId };
    };

    private readonly readActivePairing = async (
        storage: ComputerRelayStore,
        computerId: string,
        signal: AbortSignal,
    ) => {
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
        return new CreatedComputerPairing(new Date(row.expires_at).toISOString(), secrets.pairingCode, row.computer_id);
    };

    /** Replays retain the original identity, secrets and deadline; retries keep the same key after an ambiguous failure. */
    readonly createProjectComputerPairing = async (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedComputerPairing> => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.authorizeProject(normalizedComputerId, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveComputerPairingSecrets(pairingKey, owner.computerId, normalizedKey);
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ComputerRelayStore["requestComputerPairing"]>>;
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
                    owner.computerId,
                );
        }
    };

    readonly readProjectComputerPairing = async (computerId: string, signal: AbortSignal): Promise<PairingStatus> => {
        const owner = await this.authorizeProject(computerId, signal);
        const storage = await this.projectStorage(owner.scope, signal);
        const row = await storage.readComputerPairing(validateIdentifier(computerId, "computer_id"), signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Computer pairing request was not found");
        }
        return projectComputerPairingStatus(row, Date.now());
    };

    private readonly redeemPairing = async (
        expectedComputerId: string,
        pairingCode: string,
        computerName: string,
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
        await this.#cx.services.computerAccounts.requireActiveAccount(pairing.computer_id, signal);
        const daemonToken = await deriveComputerDaemonToken(pairingCode, pairing.computer_id, pairing.poll_token_hash);
        const claimed = await storage.claimPairing(
            {
                computerId: pairing.computer_id,
                codeHash,
                daemonHash: await hashPairingCredential(daemonToken),
                now: Date.now(),
                computerName,
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

    readonly redeemComputerPairing = async (
        computerId: string,
        pairingCode: string,
        computerName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> =>
        await this.redeemPairing(
            validateIdentifier(computerId, "computer_id"),
            pairingCode,
            computerName,
            workspaceName,
            agents,
            signal,
        );

    readonly listProjectComputers = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<readonly ComputerDescriptor[]> => {
        const access = await this.authorizeProject(computerId, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const runtimes = await storage.listComputers(signal);
        return runtimes.map(
            (row) =>
                new ComputerDescriptor(
                    parseAgents(row.agents_json),
                    row.computer_name,
                    row.workspace_name,
                    row.computer_id,
                ),
        );
    };

    readonly isProjectComputerRevoked = async (computerId: string, signal: AbortSignal): Promise<boolean> => {
        const access = await this.authorizeProject(computerId, signal);
        const storage = await this.projectStorage(access.scope, signal);
        const row = await storage.readComputer(validateIdentifier(computerId, "computer_id"), signal);
        return row !== null && computerRevokedAt(row.revoked_at) !== null;
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
