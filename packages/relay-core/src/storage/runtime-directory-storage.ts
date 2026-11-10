import { and, eq, exists, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type {
    PairingChannelRow,
    PairingClaimRow,
    RuntimeCredentialRotation,
    RuntimeDirectoryRow,
    RuntimePairingAudit,
    RuntimePairingRow,
} from "../entity/pairing/pairing-records.ts";
import { type RelayDrizzleDatabase, relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    auditEvent,
    computer,
    daemonCredential,
    retiredDaemonCredential,
    runtimePairingRequest,
    sessionAccessRevocation,
} from "../schema/project-do/index.ts";
import { keepLatestSessionAccessRevocation } from "./session-access-revocation-storage.ts";

const identityFields = {
    computer_id: computer.computerId,
};

const registrationFields = {
    claimed_at: computer.claimedAt,
    machine_name: computer.machineName,
    workspace_name: computer.workspaceName,
    agents_json: computer.agentsJson,
};
function directoryRow<
    T extends {
        registration: {
            claimed_at: number | null;
            machine_name: string | null;
            workspace_name: string | null;
            agents_json: string | null;
        };
    },
>(row: T | undefined) {
    if (!row) {
        return null;
    }
    const { registration, ...fields } = row;
    const { claimed_at, machine_name, workspace_name, agents_json } = registration;
    return {
        ...fields,
        registration:
            claimed_at !== null && machine_name !== null && workspace_name !== null && agents_json !== null
                ? { claimed_at, machine_name, workspace_name, agents_json }
                : null,
    };
}
interface CreateRuntimePairing {
    readonly computerId: string;
    readonly codeHash: string;
    readonly pollHash: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
}

// Pairing transitions commit the computer, its credentials, and the audit event together.
export class RuntimeDirectoryStorage {
    readonly #computerId: string;
    readonly #database: SqlDatabase;

    constructor(computerId: string, database: SqlDatabase) {
        this.#computerId = computerId;
        this.#database = database;
    }

    private readonly statement = (query: { readonly toSQL: () => { sql: string; params: unknown[] } }) => {
        const { sql, params } = query.toSQL();
        return this.#database.prepare(sql).bind(...params);
    };

    private readonly pairingQuery = (database: RelayDrizzleDatabase) =>
        database
            .select({
                ...identityFields,
                poll_token_hash: runtimePairingRequest.pollTokenHash,
                expires_at: runtimePairingRequest.expiresAt,
                revoked_at: computer.revokedAt,
                registration: registrationFields,
            })
            .from(runtimePairingRequest)
            .innerJoin(computer, eq(computer.computerId, runtimePairingRequest.computerId));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(computer.computerId, this.#computerId), eq(runtimePairingRequest.pairingCodeHash, codeHash)))
            .limit(1);
        return directoryRow(rows[0]);
    };

    readonly readProjectPairing = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<PairingChannelRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(computer.computerId, this.#computerId), eq(runtimePairingRequest.computerId, computerId)))
            .limit(1);
        return directoryRow(rows[0]);
    };

    readonly readRuntimePairingRequest = async (
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<RuntimePairingRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                ...identityFields,
                pairing_code_hash: runtimePairingRequest.pairingCodeHash,
                poll_token_hash: runtimePairingRequest.pollTokenHash,
                expires_at: runtimePairingRequest.expiresAt,
                created_by_owner_credential_id: runtimePairingRequest.createdByOwnerCredentialId,
            })
            .from(runtimePairingRequest)
            .innerJoin(computer, eq(computer.computerId, runtimePairingRequest.computerId))
            .where(
                and(
                    eq(computer.computerId, this.#computerId),
                    eq(runtimePairingRequest.creationIdempotencyKey, idempotencyKey),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly createRuntimePairing = async (value: CreateRuntimePairing, signal: AbortSignal): Promise<boolean> => {
        const computerId = this.#computerId;
        const sql = this.#database;
        const reservation = sql
            .prepare(`
            INSERT INTO computer (computer_id, created_at) VALUES (?, ?)
            ON CONFLICT(computer_id) DO UPDATE SET created_at = excluded.created_at,
                state = CASE WHEN connection_id IS NOT NULL THEN 'revoked' END,
                connection_epoch = connection_epoch + (connection_id IS NOT NULL),
                disconnected_at = CASE WHEN connection_id IS NOT NULL THEN excluded.created_at END,
                claimed_at = NULL, machine_name = NULL, workspace_name = NULL, agents_json = NULL, revoked_at = NULL, revoked_by_owner_credential_id = NULL
            WHERE revoked_at IS NOT NULL OR (
                claimed_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM runtime_pairing_requests WHERE computer_id = ? AND expires_at > ?)
            )
        `)
            .bind(computerId, value.now, computerId, value.now);
        const request = sql
            .prepare(`
            INSERT INTO runtime_pairing_requests
                (computer_id, pairing_code_hash, poll_token_hash, expires_at, creation_idempotency_key, created_by_owner_credential_id)
            SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1
            ON CONFLICT(computer_id) DO UPDATE SET pairing_code_hash = excluded.pairing_code_hash,
                poll_token_hash = excluded.poll_token_hash, expires_at = excluded.expires_at,
                creation_idempotency_key = excluded.creation_idempotency_key,
                created_by_owner_credential_id = excluded.created_by_owner_credential_id
        `)
            .bind(computerId, value.codeHash, value.pollHash, value.expiresAt, value.idempotencyKey, value.ownerId);
        const audit = sql
            .prepare(`
            INSERT INTO audit_events
                (category, audit_id, computer_id, actor_kind, actor_id, action, details_json, recorded_at)
            SELECT 'pairing', ?, ?, ?, ?, 'runtime_pairing.requested', ?, ? WHERE changes() = 1
        `)
            .bind(
                value.auditId,
                computerId,
                value.actorKind,
                value.actorId,
                JSON.stringify({ idempotencyKey: value.idempotencyKey }),
                value.now,
            );
        // A replacement starts with a new code and no credentials inherited from the previous daemon.
        const db = relayDrizzle(sql, signal);
        const accepted = exists(
            db
                .select({ auditId: auditEvent.auditId })
                .from(auditEvent)
                .where(and(eq(auditEvent.category, "pairing"), eq(auditEvent.auditId, value.auditId))),
        );
        const cleanup = [daemonCredential, retiredDaemonCredential].map((table) =>
            this.statement(db.delete(table).where(and(eq(table.computerId, computerId), accepted))),
        );
        const results = await sql.batch([reservation, request, audit, ...cleanup], signal);
        return results[0]?.meta.changes === 1;
    };

    readonly claim = async (
        value: {
            readonly computerId: string;
            readonly codeHash: string;
            readonly daemonHash: string;
            readonly now: number;
            readonly machineName: string;
            readonly workspaceName: string;
            readonly agents: string;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const credential = database.insert(daemonCredential).select(
            database
                .select({
                    computerId: computer.computerId,
                    tokenHash: sql<string>`${value.daemonHash}`.as("token_hash"),
                })
                .from(runtimePairingRequest)
                .innerJoin(computer, eq(computer.computerId, runtimePairingRequest.computerId))
                .where(
                    and(
                        eq(computer.computerId, this.#computerId),
                        eq(runtimePairingRequest.computerId, value.computerId),
                        eq(runtimePairingRequest.pairingCodeHash, value.codeHash),
                        gt(runtimePairingRequest.expiresAt, value.now),
                        isNull(computer.revokedAt),
                        isNull(computer.claimedAt),
                    ),
                ),
        );
        const registration = this.#database
            .prepare(`UPDATE computer SET claimed_at = ?, machine_name = ?, workspace_name = ?, agents_json = ?
            WHERE computer_id = ? AND changes() = 1`)
            .bind(value.now, value.machineName, value.workspaceName, value.agents, value.computerId);
        const audit = this.#database
            .prepare(`INSERT INTO audit_events
            (category, audit_id, computer_id, actor_kind, actor_id, action, details_json, recorded_at)
            SELECT 'pairing', ?, ?, 'runtime', ?, 'runtime_pairing.claimed', '{}', ? WHERE changes() = 1`)
            .bind(value.auditId, value.computerId, value.computerId, value.now);
        const results = await this.#database.batch([this.statement(credential), registration, audit], signal);
        return results[0]?.meta.changes === 1;
    };

    readonly recordAudit = async (value: RuntimePairingAudit, signal: AbortSignal): Promise<void> => {
        await relayDrizzle(this.#database, signal)
            .insert(auditEvent)
            .values({
                category: "pairing",
                auditId: value.auditId,
                computerId: this.#computerId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: value.action,
                detailsJson: JSON.stringify(value.details),
                recordedAt: value.recordedAt,
            })
            .onConflictDoNothing();
    };

    readonly readRuntime = async (computerId: string, signal: AbortSignal): Promise<RuntimeDirectoryRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, revoked_at: computer.revokedAt, registration: registrationFields })
            .from(computer)
            .where(and(eq(computer.computerId, this.#computerId), eq(computer.computerId, computerId)))
            .limit(1);
        return directoryRow(rows[0]);
    };

    readonly readDaemon = async (computerId: string, tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select(identityFields)
            .from(computer)
            .innerJoin(daemonCredential, eq(daemonCredential.computerId, computer.computerId))
            .where(
                and(
                    eq(computer.computerId, this.#computerId),
                    eq(computer.computerId, computerId),
                    isNull(computer.revokedAt),
                    eq(daemonCredential.tokenHash, tokenHash),
                    isNotNull(computer.claimedAt),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    /**
     * Presents a daemon credential with the successor the daemon saved before connecting. A current credential is
     * retired, remembering the successor that replaced it, and the successor becomes current. A retired credential
     * still identifies its Runtime: presented with the successor that replaced it, while that successor is current, it
     * repeats a rotation whose reply was lost; presented any other way, a copy of it is in use elsewhere.
     */
    readonly rotateDaemonCredential = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<RuntimeCredentialRotation> => {
        const database = relayDrizzle(this.#database, signal);
        const runtimeOf = (revoked: boolean) =>
            database
                .select({ computerId: computer.computerId })
                .from(computer)
                .where(
                    and(
                        eq(computer.computerId, this.#computerId),
                        isNotNull(computer.claimedAt),
                        revoked ? isNotNull(computer.revokedAt) : isNull(computer.revokedAt),
                    ),
                );
        const current = and(
            eq(daemonCredential.tokenHash, presentedHash),
            inArray(daemonCredential.computerId, runtimeOf(false)),
        );
        // One batch: the presented credential is retired with its successor exactly when the successor replaces it.
        await this.#database.batch(
            [
                database.insert(retiredDaemonCredential).select(
                    database
                        .select({
                            tokenHash: daemonCredential.tokenHash,
                            computerId: daemonCredential.computerId,
                            successorHash: sql<string>`${successorHash}`.as("successor_hash"),
                        })
                        .from(daemonCredential)
                        .where(current),
                ),
                database.update(daemonCredential).set({ tokenHash: successorHash }).where(current),
            ].map(this.statement),
            signal,
        );
        const rows = await database
            .select({
                ...identityFields,
                successor_hash: retiredDaemonCredential.successorHash,
                current_hash: daemonCredential.tokenHash,
            })
            .from(retiredDaemonCredential)
            .innerJoin(computer, eq(computer.computerId, retiredDaemonCredential.computerId))
            .innerJoin(daemonCredential, eq(daemonCredential.computerId, computer.computerId))
            .where(
                and(
                    eq(retiredDaemonCredential.tokenHash, presentedHash),
                    inArray(retiredDaemonCredential.computerId, runtimeOf(false)),
                ),
            )
            .limit(1);
        const row = rows[0];
        if (row !== undefined) {
            const runtime = { computer_id: row.computer_id };
            return row.successor_hash === successorHash && row.current_hash === successorHash
                ? { kind: "rotated", runtime }
                : { kind: "reused", runtime };
        }
        // A revoked Runtime keeps its credential hashes, so its daemon learns that its access ended for good.
        const revoked = await database
            .select({ computerId: daemonCredential.computerId })
            .from(daemonCredential)
            .where(
                and(
                    eq(daemonCredential.tokenHash, presentedHash),
                    inArray(daemonCredential.computerId, runtimeOf(true)),
                ),
            )
            .union(
                database
                    .select({ computerId: retiredDaemonCredential.computerId })
                    .from(retiredDaemonCredential)
                    .where(
                        and(
                            eq(retiredDaemonCredential.tokenHash, presentedHash),
                            inArray(retiredDaemonCredential.computerId, runtimeOf(true)),
                        ),
                    ),
            )
            .limit(1);
        return revoked.length === 0 ? { kind: "unknown" } : { kind: "revoked" };
    };

    readonly revokeRuntime = async (
        value: {
            readonly computerId: string;
            readonly ownerId: string | null;
            readonly now: number;
            readonly actorKind: string;
            readonly actorId: string;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ): Promise<RuntimeDirectoryRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const identity = and(eq(computer.computerId, this.#computerId), eq(computer.computerId, value.computerId));
        const revocation = database
            .update(computer)
            .set({
                revokedAt: sql`coalesce(${computer.revokedAt}, ${value.now})`,
                revokedByOwnerCredentialId: sql`case when ${computer.revokedAt} is null
                    then ${value.ownerId} else ${computer.revokedByOwnerCredentialId} end`,
            })
            .where(identity);
        const audit = this.#database
            .prepare(`INSERT INTO audit_events
            (category, audit_id, computer_id, actor_kind, actor_id, action, details_json, recorded_at)
            SELECT 'pairing', ?, computer_id, ?, ?, 'runtime_pairing.revoked', '{}', revoked_at
            FROM computer WHERE computer_id = ? AND revoked_at IS NOT NULL AND changes() = 1
            ON CONFLICT DO NOTHING`)
            .bind(value.auditId, value.actorKind, value.actorId, value.computerId);
        // Revoking the Runtime also revokes the Session credentials issued until then. That record outlives the
        // computer's revocation, which pairing it again clears.
        const sessionAccess = database
            .insert(sessionAccessRevocation)
            .select(
                database
                    .select({
                        computerId: computer.computerId,
                        revokedAt: sql<number>`${computer.revokedAt}`.as("revoked_at"),
                    })
                    .from(computer)
                    .where(and(identity, isNotNull(computer.revokedAt))),
            )
            .onConflictDoUpdate(keepLatestSessionAccessRevocation);
        const results = await this.#database.batch(
            [this.statement(revocation), audit, this.statement(sessionAccess)],
            signal,
        );
        // All writers preserve the first revocation time. Reading the committed
        // fact also makes overlapping retries return that same timestamp.
        return results[0]?.meta.changes === 1 ? this.readRuntime(value.computerId, signal) : null;
    };

    readonly readChannel = async (computerId: string, signal: AbortSignal) => {
        const row = await this.readRuntime(computerId, signal);
        return row?.registration && row.revoked_at === null
            ? { computer_id: row.computer_id, ...row.registration }
            : null;
    };

    readonly listRuntimes = async (signal: AbortSignal) => {
        const channel = await this.readChannel(this.#computerId, signal);
        return channel === null ? [] : [channel];
    };

    readonly updateAgents = async (computerId: string, tokenHash: string, agents: string, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        const identity = database
            .select({ computerId: computer.computerId })
            .from(computer)
            .innerJoin(daemonCredential, eq(daemonCredential.computerId, computer.computerId))
            .where(
                and(
                    eq(computer.computerId, this.#computerId),
                    eq(computer.computerId, computerId),
                    isNull(computer.revokedAt),
                    eq(daemonCredential.tokenHash, tokenHash),
                    isNotNull(computer.claimedAt),
                ),
            );
        return this.statement(
            database
                .update(computer)
                .set({ agentsJson: agents })
                .where(and(isNotNull(computer.claimedAt), eq(computer.computerId, identity))),
        ).run(signal);
    };
}
