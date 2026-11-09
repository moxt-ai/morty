import { and, count, eq, exists, gt, inArray, isNotNull, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { MAX_DAEMONS_PER_COMPUTER } from "../entity/pairing/pairing.ts";
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
    channelAccessGrant,
    channelHostCredential,
    pairedDaemon,
    runtimeDaemonCredential,
    runtimeDaemonRetiredCredential,
    runtimePairingAuditEvent,
    runtimePairingRequest,
    runtimeRegistration,
} from "../schema/project-do/index.ts";

const identityFields = {
    computer_id: pairedDaemon.computerId,
};
const registrationFields = {
    claimed_at: runtimeRegistration.claimedAt,
    agents_json: runtimeRegistration.agentsJson,
    machine_name: runtimeRegistration.machineName,
    workspace_name: runtimeRegistration.workspaceName,
};

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

function occupiedRuntimeCount(database: RelayDrizzleDatabase, computerId: string, now: number) {
    return database
        .select({ count: count() })
        .from(pairedDaemon)
        .where(
            and(
                eq(pairedDaemon.computerId, computerId),
                isNull(pairedDaemon.revokedAt),
                or(
                    exists(
                        database
                            .select({ computerId: runtimeRegistration.computerId })
                            .from(runtimeRegistration)
                            .where(eq(runtimeRegistration.computerId, pairedDaemon.computerId)),
                    ),
                    exists(
                        database
                            .select({ computerId: runtimePairingRequest.computerId })
                            .from(runtimePairingRequest)
                            .where(
                                and(
                                    eq(runtimePairingRequest.computerId, pairedDaemon.computerId),
                                    gt(runtimePairingRequest.expiresAt, now),
                                ),
                            ),
                    ),
                ),
            ),
        );
}

// This is the sole writer of Runtime identities, pairing requests,
// registrations, and daemon credentials. Every cross-record transition is a
// command whose writes and audit event commit together in one database batch.
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
                revoked_at: pairedDaemon.revokedAt,
                registration: registrationFields,
            })
            .from(runtimePairingRequest)
            .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, runtimePairingRequest.computerId))
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(
                and(eq(pairedDaemon.computerId, this.#computerId), eq(runtimePairingRequest.pairingCodeHash, codeHash)),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readProjectPairing = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<PairingChannelRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), eq(runtimePairingRequest.computerId, computerId)))
            .limit(1);
        return rows[0] ?? null;
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
            .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, runtimePairingRequest.computerId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
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
            INSERT INTO runtimes (computer_id, created_at) VALUES (?, ?)
            ON CONFLICT(computer_id) DO UPDATE SET created_at = excluded.created_at,
                revoked_at = NULL, revoked_by_owner_credential_id = NULL
            WHERE revoked_at IS NOT NULL OR (
                NOT EXISTS (SELECT 1 FROM runtime_registrations WHERE computer_id = ?)
                AND NOT EXISTS (SELECT 1 FROM runtime_pairing_requests WHERE computer_id = ? AND expires_at > ?)
            )
        `)
            .bind(computerId, value.now, computerId, computerId, value.now);
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
            INSERT INTO runtime_pairing_audit_events
                (audit_id, computer_id, actor_kind, actor_id, action, details_json, recorded_at)
            SELECT ?, ?, ?, ?, 'runtime_pairing.requested', ?, ? WHERE changes() = 1
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
                .select({ auditId: runtimePairingAuditEvent.auditId })
                .from(runtimePairingAuditEvent)
                .where(eq(runtimePairingAuditEvent.auditId, value.auditId)),
        );
        const cleanup = [runtimeRegistration, runtimeDaemonCredential, runtimeDaemonRetiredCredential].map((table) =>
            this.statement(db.delete(table).where(and(eq(table.computerId, computerId), accepted))),
        );
        const revokeHosts = db
            .update(channelHostCredential)
            .set({ revokedAt: value.now })
            .where(
                and(
                    eq(channelHostCredential.computerId, computerId),
                    isNull(channelHostCredential.revokedAt),
                    accepted,
                ),
            );
        const expireGrants = db
            .update(channelAccessGrant)
            .set({ expiresAt: value.now })
            .where(
                and(
                    eq(channelAccessGrant.computerId, computerId),
                    gt(channelAccessGrant.expiresAt, value.now),
                    accepted,
                ),
            );
        const fence = sql
            .prepare(`UPDATE runtime_connection_state SET state='revoked', connection_epoch=connection_epoch+1, disconnected_at=?
            WHERE computer_id=? AND EXISTS (SELECT 1 FROM runtime_pairing_audit_events WHERE audit_id=?)`)
            .bind(value.now, computerId, value.auditId);
        const results = await sql.batch(
            [reservation, request, audit, fence, ...cleanup, this.statement(revokeHosts), this.statement(expireGrants)],
            signal,
        );
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
        const credential = database.insert(runtimeDaemonCredential).select(
            database
                .select({
                    computerId: pairedDaemon.computerId,
                    tokenHash: sql<string>`${value.daemonHash}`.as("token_hash"),
                })
                .from(runtimePairingRequest)
                .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, runtimePairingRequest.computerId))
                .where(
                    and(
                        eq(pairedDaemon.computerId, this.#computerId),
                        eq(runtimePairingRequest.computerId, value.computerId),
                        eq(runtimePairingRequest.pairingCodeHash, value.codeHash),
                        gt(runtimePairingRequest.expiresAt, value.now),
                        isNull(pairedDaemon.revokedAt),
                        // A delayed command can arrive after a newer creation
                        // has reclaimed its expired reservation. Recheck the
                        // same capacity rule inside the claim transaction.
                        lte(occupiedRuntimeCount(database, this.#computerId, value.now), MAX_DAEMONS_PER_COMPUTER),
                        notExists(
                            database
                                .select({ computerId: runtimeRegistration.computerId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.computerId, pairedDaemon.computerId)),
                        ),
                    ),
                ),
        );
        const registration = database.insert(runtimeRegistration).select(
            database
                .select({
                    computerId: runtimeDaemonCredential.computerId,
                    claimedAt: sql<number>`${value.now}`.as("claimed_at"),
                    machineName: sql<string>`${value.machineName}`.as("machine_name"),
                    workspaceName: sql<string>`${value.workspaceName}`.as("workspace_name"),
                    agentsJson: sql<string>`${value.agents}`.as("agents_json"),
                })
                .from(runtimeDaemonCredential)
                .where(
                    and(
                        eq(runtimeDaemonCredential.tokenHash, value.daemonHash),
                        notExists(
                            database
                                .select({ computerId: runtimeRegistration.computerId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.computerId, runtimeDaemonCredential.computerId)),
                        ),
                    ),
                ),
        );
        const audit = database.insert(runtimePairingAuditEvent).select(
            database
                .select({
                    auditId: sql<string>`${value.auditId}`.as("audit_id"),
                    computerId: pairedDaemon.computerId,
                    actorKind: sql<string>`'runtime'`.as("actor_kind"),
                    actorId: pairedDaemon.computerId,
                    action: sql<"runtime_pairing.claimed">`'runtime_pairing.claimed'`.as("action"),
                    detailsJson: sql<string>`'{}'`.as("details_json"),
                    recordedAt: runtimeRegistration.claimedAt,
                })
                .from(runtimeDaemonCredential)
                .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, runtimeDaemonCredential.computerId))
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
                .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.computerId, pairedDaemon.computerId))
                .where(
                    and(
                        eq(runtimeDaemonCredential.tokenHash, value.daemonHash),
                        notExists(
                            database
                                .select({ auditId: runtimePairingAuditEvent.auditId })
                                .from(runtimePairingAuditEvent)
                                .where(
                                    and(
                                        eq(runtimePairingAuditEvent.computerId, value.computerId),
                                        eq(runtimePairingAuditEvent.action, "runtime_pairing.claimed"),
                                    ),
                                ),
                        ),
                    ),
                ),
        );
        const results = await this.#database.batch(
            [this.statement(credential), this.statement(registration), this.statement(audit)],
            signal,
        );
        return results[0]?.meta.changes === 1;
    };

    readonly recordAudit = async (value: RuntimePairingAudit, signal: AbortSignal): Promise<void> => {
        await relayDrizzle(this.#database, signal)
            .insert(runtimePairingAuditEvent)
            .values({
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
            .select({ ...identityFields, revoked_at: pairedDaemon.revokedAt, registration: registrationFields })
            .from(pairedDaemon)
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), eq(pairedDaemon.computerId, computerId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readDaemon = async (computerId: string, tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select(identityFields)
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.computerId, pairedDaemon.computerId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.computerId, computerId),
                    isNull(pairedDaemon.revokedAt),
                    eq(runtimeDaemonCredential.tokenHash, tokenHash),
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
                .select({ computerId: pairedDaemon.computerId })
                .from(pairedDaemon)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
                .where(
                    and(
                        eq(pairedDaemon.computerId, this.#computerId),
                        revoked ? isNotNull(pairedDaemon.revokedAt) : isNull(pairedDaemon.revokedAt),
                    ),
                );
        const current = and(
            eq(runtimeDaemonCredential.tokenHash, presentedHash),
            inArray(runtimeDaemonCredential.computerId, runtimeOf(false)),
        );
        // One batch: the presented credential is retired with its successor exactly when the successor replaces it.
        await this.#database.batch(
            [
                database.insert(runtimeDaemonRetiredCredential).select(
                    database
                        .select({
                            tokenHash: runtimeDaemonCredential.tokenHash,
                            computerId: runtimeDaemonCredential.computerId,
                            successorHash: sql<string>`${successorHash}`.as("successor_hash"),
                        })
                        .from(runtimeDaemonCredential)
                        .where(current),
                ),
                database.update(runtimeDaemonCredential).set({ tokenHash: successorHash }).where(current),
            ].map(this.statement),
            signal,
        );
        const rows = await database
            .select({
                ...identityFields,
                successor_hash: runtimeDaemonRetiredCredential.successorHash,
                current_hash: runtimeDaemonCredential.tokenHash,
            })
            .from(runtimeDaemonRetiredCredential)
            .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, runtimeDaemonRetiredCredential.computerId))
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.computerId, pairedDaemon.computerId))
            .where(
                and(
                    eq(runtimeDaemonRetiredCredential.tokenHash, presentedHash),
                    inArray(runtimeDaemonRetiredCredential.computerId, runtimeOf(false)),
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
            .select({ computerId: runtimeDaemonCredential.computerId })
            .from(runtimeDaemonCredential)
            .where(
                and(
                    eq(runtimeDaemonCredential.tokenHash, presentedHash),
                    inArray(runtimeDaemonCredential.computerId, runtimeOf(true)),
                ),
            )
            .union(
                database
                    .select({ computerId: runtimeDaemonRetiredCredential.computerId })
                    .from(runtimeDaemonRetiredCredential)
                    .where(
                        and(
                            eq(runtimeDaemonRetiredCredential.tokenHash, presentedHash),
                            inArray(runtimeDaemonRetiredCredential.computerId, runtimeOf(true)),
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
        const identity = and(
            eq(pairedDaemon.computerId, this.#computerId),
            eq(pairedDaemon.computerId, value.computerId),
        );
        const revocation = database
            .update(pairedDaemon)
            .set({
                revokedAt: sql`coalesce(${pairedDaemon.revokedAt}, ${value.now})`,
                revokedByOwnerCredentialId: sql`case when ${pairedDaemon.revokedAt} is null
                    then ${value.ownerId} else ${pairedDaemon.revokedByOwnerCredentialId} end`,
            })
            .where(identity);
        const audit = database
            .insert(runtimePairingAuditEvent)
            .select(
                database
                    .select({
                        auditId: sql<string>`${value.auditId}`.as("audit_id"),
                        computerId: pairedDaemon.computerId,
                        actorKind: sql<string>`${value.actorKind}`.as("actor_kind"),
                        actorId: sql<string>`${value.actorId}`.as("actor_id"),
                        action: sql<"runtime_pairing.revoked">`'runtime_pairing.revoked'`.as("action"),
                        detailsJson: sql<string>`'{}'`.as("details_json"),
                        recordedAt: sql<number>`${pairedDaemon.revokedAt}`.as("recorded_at"),
                    })
                    .from(pairedDaemon)
                    .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.computerId, pairedDaemon.computerId))
                    .where(identity),
            )
            .onConflictDoNothing();
        const results = await this.#database.batch([revocation, audit].map(this.statement), signal);
        // All writers preserve the first revocation time. Reading the committed
        // fact also makes overlapping retries return that same timestamp.
        return results[0]?.meta.changes === 1 ? this.readRuntime(value.computerId, signal) : null;
    };

    readonly listRuntimes = async (signal: AbortSignal) =>
        await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), isNull(pairedDaemon.revokedAt)))
            .orderBy(pairedDaemon.createdAt, pairedDaemon.computerId)
            .limit(100);

    readonly readChannel = async (computerId: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.computerId, computerId),
                    isNull(pairedDaemon.revokedAt),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly updateAgents = async (computerId: string, tokenHash: string, agents: string, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        const identity = database
            .select({ computerId: pairedDaemon.computerId })
            .from(pairedDaemon)
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.computerId, pairedDaemon.computerId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.computerId, computerId),
                    isNull(pairedDaemon.revokedAt),
                    eq(runtimeDaemonCredential.tokenHash, tokenHash),
                ),
            );
        return this.statement(
            database
                .update(runtimeRegistration)
                .set({ agentsJson: agents })
                .where(eq(runtimeRegistration.computerId, identity)),
        ).run(signal);
    };
}
