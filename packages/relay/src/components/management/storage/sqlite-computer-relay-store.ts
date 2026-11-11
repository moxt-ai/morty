import type { SqlDatabase } from "../../../infra/sql-database.ts";
import { ComputerCredentialStorage } from "./computer-credential-storage.ts";
import { ComputerDirectoryStorage } from "./computer-directory-storage.ts";
import type { ComputerRelayStore } from "./computer-relay-store.ts";
import { credentialMatches } from "./pairing-identity-storage.ts";

/**
 * A Project's operations over its own SQLite storage. Only the Project's storage owner constructs this; each
 * operation runs there as one unit, so its reads, writes and audit events cannot interleave with another operation.
 */
export class SqliteComputerRelayStore implements ComputerRelayStore {
    readonly #computerId: string;
    readonly #database: SqlDatabase;
    readonly #runtimes: ComputerDirectoryStorage;
    readonly #credentials: ComputerCredentialStorage;

    constructor(computerId: string, database: SqlDatabase) {
        this.#computerId = computerId;
        this.#database = database;
        this.#runtimes = new ComputerDirectoryStorage(computerId, database);
        this.#credentials = new ComputerCredentialStorage(database);
    }

    readonly updateAgentCatalog: ComputerRelayStore["updateAgentCatalog"] = async (
        computerId,
        tokenHash,
        agents,
        signal,
    ) => (await this.#runtimes.updateAgents(computerId, tokenHash, agents, signal)).meta.changes === 1;

    readonly readActiveGeneration: ComputerRelayStore["readActiveGeneration"] = async (computerId, signal) =>
        computerId === this.#computerId ? await this.#credentials.readActiveGeneration({ computerId }, signal) : null;

    readonly readRuntime: ComputerRelayStore["readRuntime"] = async (computerId, signal) =>
        await this.#runtimes.readRuntime(computerId, signal);

    readonly listRuntimes: ComputerRelayStore["listRuntimes"] = async (signal) =>
        await this.#runtimes.listRuntimes(signal);

    readonly requestRuntimePairing: ComputerRelayStore["requestRuntimePairing"] = async (value, signal) => {
        const existing = await this.#runtimes.readRuntimePairingRequest(value.idempotencyKey, signal);
        if (existing !== null) {
            return { kind: "existing", request: existing };
        }
        if (await this.#runtimes.createRuntimePairing(value, signal)) {
            return { kind: "created" };
        }
        await this.#runtimes.recordAudit(
            {
                auditId: value.rejectionAuditId,
                computerId: this.#computerId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: "runtime_pairing.rejected",
                details: { code: "runtime_quota_exceeded" },
                recordedAt: value.now,
            },
            signal,
        );
        return { kind: "quota_exceeded" };
    };

    readonly readRuntimePairing: ComputerRelayStore["readRuntimePairing"] = async (computerId, signal) =>
        await this.#runtimes.readProjectPairing(computerId, signal);

    readonly readPairingCode: ComputerRelayStore["readPairingCode"] = async (codeHash, signal) =>
        await this.#runtimes.readPairingCode(codeHash, signal);

    readonly claimPairing: ComputerRelayStore["claimPairing"] = async (value, signal) => {
        if (await this.#runtimes.claim(value, signal)) {
            return true;
        }
        // Replays prove possession of the original code and must match the committed credential. Never rotate an
        // retired credential, extend the pairing deadline, or resurrect a revoked Runtime.
        const pairing = await this.#runtimes.readProjectPairing(value.computerId, signal);
        if (
            pairing !== null &&
            pairing.expires_at > value.now &&
            (await this.#runtimes.readDaemon(pairing.computer_id, value.daemonHash, signal)) !== null
        ) {
            return true;
        }
        await this.#runtimes.recordAudit(
            {
                auditId: value.rejectionAuditId,
                computerId: this.#computerId,
                actorKind: "pairing_code",
                actorId: value.computerId,
                action: "runtime_pairing.rejected",
                details: { code: "invalid_pairing_code" },
                recordedAt: value.now,
            },
            signal,
        );
        return false;
    };

    readonly revokeRuntime: ComputerRelayStore["revokeRuntime"] = async (value, signal) =>
        await this.#runtimes.revokeRuntime(value, signal);

    readonly findCredential: ComputerRelayStore["findCredential"] = async (credential, signal) =>
        await credentialMatches(this.#database, credential, signal);

    readonly rotateRuntimeCredential: ComputerRelayStore["rotateRuntimeCredential"] = async (
        presentedHash,
        successorHash,
        signal,
    ) => await this.#runtimes.rotateDaemonCredential(presentedHash, successorHash, signal);
}
