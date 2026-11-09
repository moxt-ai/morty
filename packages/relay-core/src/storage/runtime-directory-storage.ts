import { and, count, eq, exists, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
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
    pairedDaemon,
    runtimeDaemonCredential,
    runtimeDaemonRetiredCredential,
    runtimePairingAuditEvent,
    runtimePairingRequest,
    runtimeRegistration,
} from "../schema/project-do/index.ts";

const identityFields = {
    channel_id: pairedDaemon.channelId,
    pairing_id: pairedDaemon.pairingId,
    project_id: pairedDaemon.computerId,
};
const registrationFields = {
    claimed_at: runtimeRegistration.claimedAt,
    agents_json: runtimeRegistration.agentsJson,
    machine_name: runtimeRegistration.machineName,
    workspace_name: runtimeRegistration.workspaceName,
};

interface CreateRuntimePairing {
    readonly pairingId: string;
    readonly codeHash: string;
    readonly pollHash: string;
    readonly channelId: string;
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
                            .select({ pairingId: runtimeRegistration.pairingId })
                            .from(runtimeRegistration)
                            .where(eq(runtimeRegistration.pairingId, pairedDaemon.pairingId)),
                    ),
                    exists(
                        database
                            .select({ pairingId: runtimePairingRequest.pairingId })
                            .from(runtimePairingRequest)
                            .where(
                                and(
                                    eq(runtimePairingRequest.pairingId, pairedDaemon.pairingId),
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
            .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimePairingRequest.pairingId))
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(
                and(eq(pairedDaemon.computerId, this.#computerId), eq(runtimePairingRequest.pairingCodeHash, codeHash)),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readProjectPairing = async (pairingId: string, signal: AbortSignal): Promise<PairingChannelRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), eq(runtimePairingRequest.pairingId, pairingId)))
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
            .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimePairingRequest.pairingId))
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
        const database = relayDrizzle(this.#database, signal);
        // The capacity predicate is part of the INSERT, not an earlier read.
        // SQLite serializes this batch with competing creations, claims, and
        // revocations. Expired requests need no cleanup to stop reserving space.
        const identity = database.insert(pairedDaemon).select(
            database
                .select({
                    pairingId: sql<string>`${value.pairingId}`.as("pairing_id"),
                    channelId: sql<string>`${value.channelId}`.as("channel_id"),
                    computerId: sql<string>`${this.#computerId}`.as("project_id"),
                    createdAt: sql<number>`${value.now}`.as("created_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    revokedByOwnerCredentialId: sql<null>`null`.as("revoked_by_owner_credential_id"),
                })
                .from(sql`(select 1)`)
                .where(lt(occupiedRuntimeCount(database, this.#computerId, value.now), MAX_DAEMONS_PER_COMPUTER)),
        );
        const request = database.insert(runtimePairingRequest).select(
            database
                .select({
                    pairingId: sql<string>`${value.pairingId}`.as("pairing_id"),
                    pairingCodeHash: sql<string>`${value.codeHash}`.as("pairing_code_hash"),
                    pollTokenHash: sql<string>`${value.pollHash}`.as("poll_token_hash"),
                    expiresAt: sql<number>`${value.expiresAt}`.as("expires_at"),
                    creationIdempotencyKey: sql<string>`${value.idempotencyKey}`.as("creation_idempotency_key"),
                    createdByOwnerCredentialId: sql<string>`${value.ownerId}`.as("created_by_owner_credential_id"),
                })
                .from(pairedDaemon)
                .where(eq(pairedDaemon.pairingId, value.pairingId)),
        );
        const audit = database.insert(runtimePairingAuditEvent).select(
            database
                .select({
                    auditId: sql<string>`${value.auditId}`.as("audit_id"),
                    computerId: pairedDaemon.computerId,
                    pairingId: runtimePairingRequest.pairingId,
                    actorKind: sql<string>`${value.actorKind}`.as("actor_kind"),
                    actorId: sql<string>`${value.actorId}`.as("actor_id"),
                    action: sql<"runtime_pairing.requested">`'runtime_pairing.requested'`.as("action"),
                    detailsJson: sql<string>`${JSON.stringify({ idempotencyKey: value.idempotencyKey })}`.as(
                        "details_json",
                    ),
                    recordedAt: pairedDaemon.createdAt,
                })
                .from(runtimePairingRequest)
                .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimePairingRequest.pairingId))
                .where(eq(runtimePairingRequest.pairingId, value.pairingId)),
        );
        const results = await this.#database.batch(
            [this.statement(identity), this.statement(request), this.statement(audit)],
            signal,
        );
        return results[0]?.meta.changes === 1;
    };

    readonly claim = async (
        value: {
            readonly pairingId: string;
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
                    pairingId: pairedDaemon.pairingId,
                    tokenHash: sql<string>`${value.daemonHash}`.as("token_hash"),
                })
                .from(runtimePairingRequest)
                .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimePairingRequest.pairingId))
                .where(
                    and(
                        eq(pairedDaemon.computerId, this.#computerId),
                        eq(runtimePairingRequest.pairingId, value.pairingId),
                        eq(runtimePairingRequest.pairingCodeHash, value.codeHash),
                        gt(runtimePairingRequest.expiresAt, value.now),
                        isNull(pairedDaemon.revokedAt),
                        // A delayed command can arrive after a newer creation
                        // has reclaimed its expired reservation. Recheck the
                        // same capacity rule inside the claim transaction.
                        lte(occupiedRuntimeCount(database, this.#computerId, value.now), MAX_DAEMONS_PER_COMPUTER),
                        notExists(
                            database
                                .select({ pairingId: runtimeRegistration.pairingId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.pairingId, pairedDaemon.pairingId)),
                        ),
                    ),
                ),
        );
        const registration = database.insert(runtimeRegistration).select(
            database
                .select({
                    pairingId: runtimeDaemonCredential.pairingId,
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
                                .select({ pairingId: runtimeRegistration.pairingId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.pairingId, runtimeDaemonCredential.pairingId)),
                        ),
                    ),
                ),
        );
        const audit = database.insert(runtimePairingAuditEvent).select(
            database
                .select({
                    auditId: sql<string>`${value.auditId}`.as("audit_id"),
                    computerId: pairedDaemon.computerId,
                    pairingId: runtimePairingRequest.pairingId,
                    actorKind: sql<string>`'runtime'`.as("actor_kind"),
                    actorId: pairedDaemon.pairingId,
                    action: sql<"runtime_pairing.claimed">`'runtime_pairing.claimed'`.as("action"),
                    detailsJson: sql<string>`'{}'`.as("details_json"),
                    recordedAt: runtimeRegistration.claimedAt,
                })
                .from(runtimeDaemonCredential)
                .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimeDaemonCredential.pairingId))
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
                .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.pairingId, pairedDaemon.pairingId))
                .where(
                    and(
                        eq(runtimeDaemonCredential.tokenHash, value.daemonHash),
                        notExists(
                            database
                                .select({ auditId: runtimePairingAuditEvent.auditId })
                                .from(runtimePairingAuditEvent)
                                .where(
                                    and(
                                        eq(runtimePairingAuditEvent.pairingId, value.pairingId),
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
                pairingId: value.pairingId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: value.action,
                detailsJson: JSON.stringify(value.details),
                recordedAt: value.recordedAt,
            })
            .onConflictDoNothing();
    };

    readonly readRuntime = async (pairingId: string, signal: AbortSignal): Promise<RuntimeDirectoryRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, revoked_at: pairedDaemon.revokedAt, registration: registrationFields })
            .from(pairedDaemon)
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), eq(pairedDaemon.pairingId, pairingId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readDaemon = async (channelId: string, tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select(identityFields)
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.pairingId, pairedDaemon.pairingId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.channelId, channelId),
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
                .select({ pairingId: pairedDaemon.pairingId })
                .from(pairedDaemon)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
                .where(
                    and(
                        eq(pairedDaemon.computerId, this.#computerId),
                        revoked ? isNotNull(pairedDaemon.revokedAt) : isNull(pairedDaemon.revokedAt),
                    ),
                );
        const current = and(
            eq(runtimeDaemonCredential.tokenHash, presentedHash),
            inArray(runtimeDaemonCredential.pairingId, runtimeOf(false)),
        );
        // One batch: the presented credential is retired with its successor exactly when the successor replaces it.
        await this.#database.batch(
            [
                database.insert(runtimeDaemonRetiredCredential).select(
                    database
                        .select({
                            tokenHash: runtimeDaemonCredential.tokenHash,
                            pairingId: runtimeDaemonCredential.pairingId,
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
            .innerJoin(pairedDaemon, eq(pairedDaemon.pairingId, runtimeDaemonRetiredCredential.pairingId))
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.pairingId, pairedDaemon.pairingId))
            .where(
                and(
                    eq(runtimeDaemonRetiredCredential.tokenHash, presentedHash),
                    inArray(runtimeDaemonRetiredCredential.pairingId, runtimeOf(false)),
                ),
            )
            .limit(1);
        const row = rows[0];
        if (row !== undefined) {
            const runtime = { channel_id: row.channel_id, pairing_id: row.pairing_id, project_id: row.project_id };
            return row.successor_hash === successorHash && row.current_hash === successorHash
                ? { kind: "rotated", runtime }
                : { kind: "reused", runtime };
        }
        // A revoked Runtime keeps its credential hashes, so its daemon learns that its access ended for good.
        const revoked = await database
            .select({ pairingId: runtimeDaemonCredential.pairingId })
            .from(runtimeDaemonCredential)
            .where(
                and(
                    eq(runtimeDaemonCredential.tokenHash, presentedHash),
                    inArray(runtimeDaemonCredential.pairingId, runtimeOf(true)),
                ),
            )
            .union(
                database
                    .select({ pairingId: runtimeDaemonRetiredCredential.pairingId })
                    .from(runtimeDaemonRetiredCredential)
                    .where(
                        and(
                            eq(runtimeDaemonRetiredCredential.tokenHash, presentedHash),
                            inArray(runtimeDaemonRetiredCredential.pairingId, runtimeOf(true)),
                        ),
                    ),
            )
            .limit(1);
        return revoked.length === 0 ? { kind: "unknown" } : { kind: "revoked" };
    };

    readonly revokeRuntime = async (
        value: {
            readonly pairingId: string;
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
            eq(pairedDaemon.pairingId, value.pairingId),
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
                        pairingId: runtimePairingRequest.pairingId,
                        actorKind: sql<string>`${value.actorKind}`.as("actor_kind"),
                        actorId: sql<string>`${value.actorId}`.as("actor_id"),
                        action: sql<"runtime_pairing.revoked">`'runtime_pairing.revoked'`.as("action"),
                        detailsJson: sql<string>`'{}'`.as("details_json"),
                        recordedAt: sql<number>`${pairedDaemon.revokedAt}`.as("recorded_at"),
                    })
                    .from(pairedDaemon)
                    .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.pairingId, pairedDaemon.pairingId))
                    .where(identity),
            )
            .onConflictDoNothing();
        const results = await this.#database.batch([revocation, audit].map(this.statement), signal);
        // All writers preserve the first revocation time. Reading the committed
        // fact also makes overlapping retries return that same timestamp.
        return results[0]?.meta.changes === 1 ? this.readRuntime(value.pairingId, signal) : null;
    };

    readonly listRuntimes = async (signal: AbortSignal) =>
        await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
            .where(and(eq(pairedDaemon.computerId, this.#computerId), isNull(pairedDaemon.revokedAt)))
            .orderBy(pairedDaemon.createdAt, pairedDaemon.channelId)
            .limit(100);

    readonly readChannel = async (channelId: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.pairingId, pairedDaemon.pairingId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.channelId, channelId),
                    isNull(pairedDaemon.revokedAt),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly updateAgents = async (channelId: string, tokenHash: string, agents: string, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        const identity = database
            .select({ pairingId: pairedDaemon.pairingId })
            .from(pairedDaemon)
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.pairingId, pairedDaemon.pairingId))
            .where(
                and(
                    eq(pairedDaemon.computerId, this.#computerId),
                    eq(pairedDaemon.channelId, channelId),
                    isNull(pairedDaemon.revokedAt),
                    eq(runtimeDaemonCredential.tokenHash, tokenHash),
                ),
            );
        return this.statement(
            database
                .update(runtimeRegistration)
                .set({ agentsJson: agents })
                .where(eq(runtimeRegistration.pairingId, identity)),
        ).run(signal);
    };
}
