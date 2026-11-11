import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
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
    readonly #database: DurableObjectDatabase;
    readonly #computers: ComputerDirectoryStorage;
    readonly #credentials: ComputerCredentialStorage;

    constructor(computerId: string, database: DurableObjectDatabase) {
        this.#computerId = computerId;
        this.#database = database;
        this.#computers = new ComputerDirectoryStorage(computerId, database);
        this.#credentials = new ComputerCredentialStorage(database);
    }

    readonly updateAgentCatalog: ComputerRelayStore["updateAgentCatalog"] = async (
        computerId,
        tokenHash,
        agents,
        signal,
    ) => (await this.#computers.updateAgents(computerId, tokenHash, agents, signal)).meta.changes === 1;

    readonly readActiveGeneration: ComputerRelayStore["readActiveGeneration"] = async (computerId, signal) =>
        computerId === this.#computerId ? await this.#credentials.readActiveGeneration({ computerId }, signal) : null;

    readonly readComputer: ComputerRelayStore["readComputer"] = async (computerId, signal) =>
        await this.#computers.readComputer(computerId, signal);

    readonly listComputers: ComputerRelayStore["listComputers"] = async (signal) =>
        await this.#computers.listComputers(signal);

    readonly requestComputerPairing: ComputerRelayStore["requestComputerPairing"] = async (value, signal) => {
        const existing = await this.#computers.readComputerPairingRequest(value.idempotencyKey, signal);
        if (existing !== null) {
            return { kind: "existing", request: existing };
        }
        if (await this.#computers.createComputerPairing(value, signal)) {
            return { kind: "created" };
        }
        await this.#computers.recordAudit(
            {
                auditId: value.rejectionAuditId,
                computerId: this.#computerId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: "computer_pairing.rejected",
                details: { code: "computer_quota_exceeded" },
                recordedAt: value.now,
            },
            signal,
        );
        return { kind: "quota_exceeded" };
    };

    readonly readComputerPairing: ComputerRelayStore["readComputerPairing"] = async (computerId, signal) =>
        await this.#computers.readProjectPairing(computerId, signal);

    readonly readPairingCode: ComputerRelayStore["readPairingCode"] = async (codeHash, signal) =>
        await this.#computers.readPairingCode(codeHash, signal);

    readonly claimPairing: ComputerRelayStore["claimPairing"] = async (value, signal) => {
        if (await this.#computers.claim(value, signal)) {
            return true;
        }
        // Replays prove possession of the original code and must match the committed credential. Never rotate an
        // retired credential, extend the pairing deadline, or resurrect a revoked Computer.
        const pairing = await this.#computers.readProjectPairing(value.computerId, signal);
        if (
            pairing !== null &&
            pairing.expires_at > value.now &&
            (await this.#computers.readDaemon(pairing.computer_id, value.daemonHash, signal)) !== null
        ) {
            return true;
        }
        await this.#computers.recordAudit(
            {
                auditId: value.rejectionAuditId,
                computerId: this.#computerId,
                actorKind: "pairing_code",
                actorId: value.computerId,
                action: "computer_pairing.rejected",
                details: { code: "invalid_pairing_code" },
                recordedAt: value.now,
            },
            signal,
        );
        return false;
    };

    readonly revokeComputer: ComputerRelayStore["revokeComputer"] = async (value, signal) =>
        await this.#computers.revokeComputer(value, signal);

    readonly findCredential: ComputerRelayStore["findCredential"] = async (credential, signal) =>
        await credentialMatches(this.#database, credential, signal);

    readonly rotateComputerCredential: ComputerRelayStore["rotateComputerCredential"] = async (
        presentedHash,
        successorHash,
        signal,
    ) => await this.#computers.rotateDaemonCredential(presentedHash, successorHash, signal);
}
