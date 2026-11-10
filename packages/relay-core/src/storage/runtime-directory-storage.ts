import { and, count, eq, gt, inArray, isNotNull, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
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
    daemonCredential,
    retiredDaemonCredential,
    runtimePairing,
    runtimeRegistration,
    runtimeRevocation,
} from "../schema/project-do/index.ts";
import { activeGeneration, currentGeneration } from "./runtime-generation.ts";

const registrationFields = {
    claimed_at: runtimeRegistration.claimedAt,
    machine_name: runtimeRegistration.machineName,
    workspace_name: runtimeRegistration.workspaceName,
    agents_json: runtimeRegistration.agentsJson,
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

/** A bound value selected as a column, for rows an INSERT ... SELECT writes. */
const bound = <T>(value: T, name: string) => sql<T>`${value}`.as(name);

/** Every column of a pairing audit event, in table order, for an INSERT ... SELECT. */
const pairingAudit = (event: {
    readonly auditId: string;
    readonly computerId: AnySQLiteColumn | SQL.Aliased<string>;
    readonly actorKind: string;
    readonly actorId: AnySQLiteColumn | SQL.Aliased<string>;
    readonly action: RuntimePairingAudit["action"];
    readonly details: string;
    readonly recordedAt: AnySQLiteColumn | SQL.Aliased<number>;
}) => ({
    category: bound("pairing" as const, "category"),
    auditId: bound(event.auditId, "audit_id"),
    computerId: event.computerId,
    actorKind: bound(event.actorKind, "actor_kind"),
    actorId: event.actorId,
    action: bound(event.action, "action"),
    detailsJson: bound(event.details, "details_json"),
    recordedAt: event.recordedAt,
    actorRef: bound(null, "actor_ref"),
    historicalServiceId: bound(null, "service_id"),
    subjectId: bound(null, "subject_id"),
    outcome: bound(null, "outcome"),
});

/**
 * The computer's pairing generations. Each transition records a fact of one generation and its audit event together;
 * pairing the computer again starts a new generation instead of changing an earlier one.
 */
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

    /** A generation's request, with its registration and revocation when they happened. */
    private readonly generationQuery = (database: RelayDrizzleDatabase) =>
        database
            .select({
                computer_id: runtimePairing.computerId,
                poll_token_hash: runtimePairing.pollTokenHash,
                expires_at: runtimePairing.expiresAt,
                revoked_at: runtimeRevocation.revokedAt,
                registration: registrationFields,
            })
            .from(runtimePairing)
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.generation, runtimePairing.generation))
            .leftJoin(runtimeRevocation, eq(runtimeRevocation.generation, runtimePairing.generation));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(runtimePairing.computerId, this.#computerId), eq(runtimePairing.pairingCodeHash, codeHash)))
            .limit(1);
        return rows[0] ?? null;
    };

    /** The computer's current generation; null before it was ever paired. */
    readonly readProjectPairing = async (computerId: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        if (computerId !== this.#computerId) {
            return null;
        }
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(inArray(runtimePairing.generation, currentGeneration(computerId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readRuntimePairingRequest = async (
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<RuntimePairingRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                computer_id: runtimePairing.computerId,
                pairing_code_hash: runtimePairing.pairingCodeHash,
                poll_token_hash: runtimePairing.pollTokenHash,
                expires_at: runtimePairing.expiresAt,
                created_by_owner_credential_id: runtimePairing.createdByOwnerCredentialId,
            })
            .from(runtimePairing)
            .where(
                and(
                    eq(runtimePairing.computerId, this.#computerId),
                    eq(runtimePairing.creationIdempotencyKey, idempotencyKey),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    /**
     * Starts the computer's next pairing generation, unless a generation is still open: claimed, or awaiting its claim
     * before its deadline, and in either case not revoked.
     */
    readonly createRuntimePairing = async (value: CreateRuntimePairing, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const openGenerations = database
            .select({ open: count().as("open") })
            .from(runtimePairing)
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.generation, runtimePairing.generation))
            .where(
                and(
                    eq(runtimePairing.computerId, this.#computerId),
                    notInArray(
                        runtimePairing.generation,
                        database.select({ generation: runtimeRevocation.generation }).from(runtimeRevocation),
                    ),
                    or(isNotNull(runtimeRegistration.generation), gt(runtimePairing.expiresAt, value.now)),
                ),
            )
            .as("open_generations");
        const pairing = database.insert(runtimePairing).select(
            database
                .select({
                    // SQLite assigns the next generation in place of a null one.
                    generation: bound<number | null>(null, "generation"),
                    computerId: bound(this.#computerId, "computer_id"),
                    pairingCodeHash: bound(value.codeHash, "pairing_code_hash"),
                    pollTokenHash: bound(value.pollHash, "poll_token_hash"),
                    expiresAt: bound(value.expiresAt, "expires_at"),
                    creationIdempotencyKey: bound(value.idempotencyKey, "creation_idempotency_key"),
                    createdByOwnerCredentialId: bound(value.ownerId, "created_by_owner_credential_id"),
                })
                .from(openGenerations)
                .where(eq(openGenerations.open, 0)),
        );
        const audit = database.insert(auditEvent).select(
            database
                .select(
                    pairingAudit({
                        auditId: value.auditId,
                        computerId: runtimePairing.computerId,
                        actorKind: value.actorKind,
                        actorId: bound(value.actorId, "actor_id"),
                        action: "runtime_pairing.requested",
                        details: JSON.stringify({ idempotencyKey: value.idempotencyKey }),
                        recordedAt: bound(value.now, "recorded_at"),
                    }),
                )
                .from(runtimePairing)
                .where(eq(runtimePairing.creationIdempotencyKey, value.idempotencyKey)),
        );
        const results = await this.#database.batch([this.statement(pairing), this.statement(audit)], signal);
        return results[0]?.meta.changes === 1;
    };

    /** Registers the daemon that presented the current generation's unexpired pairing code. */
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
        const claimable = database
            .select({ generation: runtimePairing.generation })
            .from(runtimePairing)
            .where(
                and(
                    eq(runtimePairing.computerId, this.#computerId),
                    inArray(runtimePairing.generation, currentGeneration(value.computerId)),
                    eq(runtimePairing.pairingCodeHash, value.codeHash),
                    gt(runtimePairing.expiresAt, value.now),
                    notInArray(
                        runtimePairing.generation,
                        database.select({ generation: runtimeRegistration.generation }).from(runtimeRegistration),
                    ),
                    notInArray(
                        runtimePairing.generation,
                        database.select({ generation: runtimeRevocation.generation }).from(runtimeRevocation),
                    ),
                ),
            );
        const credential = database.insert(daemonCredential).select(
            database
                .select({
                    generation: runtimePairing.generation,
                    tokenHash: bound(value.daemonHash, "token_hash"),
                })
                .from(runtimePairing)
                .where(inArray(runtimePairing.generation, claimable)),
        );
        // The credential written just above marks the generation this claim registers.
        const registration = database.insert(runtimeRegistration).select(
            database
                .select({
                    generation: daemonCredential.generation,
                    claimedAt: bound(value.now, "claimed_at"),
                    machineName: bound(value.machineName, "machine_name"),
                    workspaceName: bound(value.workspaceName, "workspace_name"),
                    agentsJson: bound(value.agents, "agents_json"),
                })
                .from(daemonCredential)
                .where(
                    and(
                        eq(daemonCredential.tokenHash, value.daemonHash),
                        inArray(daemonCredential.generation, claimable),
                    ),
                ),
        );
        const audit = database.insert(auditEvent).select(
            database
                .select(
                    pairingAudit({
                        auditId: value.auditId,
                        computerId: runtimePairing.computerId,
                        actorKind: "runtime",
                        actorId: runtimePairing.computerId,
                        action: "runtime_pairing.claimed",
                        details: "{}",
                        recordedAt: bound(value.now, "recorded_at"),
                    }),
                )
                .from(runtimePairing)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.generation, runtimePairing.generation))
                .where(
                    and(inArray(runtimePairing.generation, currentGeneration(value.computerId)), sql`changes() = 1`),
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

    /** The computer's current generation as a Runtime: its registration and revocation, if they happened. */
    readonly readRuntime = async (computerId: string, signal: AbortSignal): Promise<RuntimeDirectoryRow | null> => {
        const row = await this.readProjectPairing(computerId, signal);
        return row === null
            ? null
            : { computer_id: row.computer_id, revoked_at: row.revoked_at, registration: row.registration };
    };

    readonly readDaemon = async (computerId: string, tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ computer_id: runtimePairing.computerId })
            .from(daemonCredential)
            .innerJoin(runtimePairing, eq(runtimePairing.generation, daemonCredential.generation))
            .where(
                and(
                    eq(runtimePairing.computerId, this.#computerId),
                    eq(daemonCredential.tokenHash, tokenHash),
                    inArray(daemonCredential.generation, activeGeneration(computerId)),
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
        const active = activeGeneration(this.#computerId);
        const current = and(
            eq(daemonCredential.tokenHash, presentedHash),
            inArray(daemonCredential.generation, active),
        );
        // One batch: the presented credential is retired with its successor exactly when the successor replaces it.
        await this.#database.batch(
            [
                database.insert(retiredDaemonCredential).select(
                    database
                        .select({
                            tokenHash: daemonCredential.tokenHash,
                            generation: daemonCredential.generation,
                            successorHash: bound(successorHash, "successor_hash"),
                        })
                        .from(daemonCredential)
                        .where(current),
                ),
                database.update(daemonCredential).set({ tokenHash: successorHash }).where(current),
            ].map(this.statement),
            signal,
        );
        const runtime = { computer_id: this.#computerId };
        const rows = await database
            .select({
                successor_hash: retiredDaemonCredential.successorHash,
                current_hash: daemonCredential.tokenHash,
            })
            .from(retiredDaemonCredential)
            .innerJoin(daemonCredential, eq(daemonCredential.generation, retiredDaemonCredential.generation))
            .where(
                and(
                    eq(retiredDaemonCredential.tokenHash, presentedHash),
                    inArray(retiredDaemonCredential.generation, active),
                ),
            )
            .limit(1);
        const row = rows[0];
        if (row !== undefined) {
            return row.successor_hash === successorHash && row.current_hash === successorHash
                ? { kind: "rotated", runtime }
                : { kind: "reused", runtime };
        }
        // Every generation keeps its credentials, so a daemon of an ended generation learns its access ended for good,
        // also after the computer was paired again.
        const ended = await database
            .select({ generation: daemonCredential.generation })
            .from(daemonCredential)
            .where(eq(daemonCredential.tokenHash, presentedHash))
            .union(
                database
                    .select({ generation: retiredDaemonCredential.generation })
                    .from(retiredDaemonCredential)
                    .where(eq(retiredDaemonCredential.tokenHash, presentedHash)),
            )
            .limit(1);
        return ended.length === 0 ? { kind: "unknown" } : { kind: "revoked" };
    };

    /** Ends the current generation's access, once; a repeated revocation returns the first one. */
    readonly revokeRuntime = async (
        value: {
            readonly computerId: string;
            readonly now: number;
            readonly actorKind: string;
            readonly actorId: string;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ): Promise<RuntimeDirectoryRow | null> => {
        if (value.computerId !== this.#computerId) {
            return null;
        }
        const database = relayDrizzle(this.#database, signal);
        const current = currentGeneration(value.computerId);
        const revocation = database
            .insert(runtimeRevocation)
            .select(
                database
                    .select({ generation: runtimePairing.generation, revokedAt: bound(value.now, "revoked_at") })
                    .from(runtimePairing)
                    .where(inArray(runtimePairing.generation, current)),
            )
            .onConflictDoNothing();
        const audit = database.insert(auditEvent).select(
            database
                .select(
                    pairingAudit({
                        auditId: value.auditId,
                        computerId: bound(value.computerId, "computer_id"),
                        actorKind: value.actorKind,
                        actorId: bound(value.actorId, "actor_id"),
                        action: "runtime_pairing.revoked",
                        details: "{}",
                        recordedAt: runtimeRevocation.revokedAt,
                    }),
                )
                .from(runtimeRevocation)
                .where(and(inArray(runtimeRevocation.generation, current), sql`changes() = 1`)),
        );
        await this.#database.batch([this.statement(revocation), this.statement(audit)], signal);
        // Reading the committed fact makes overlapping retries return the first revocation time.
        return await this.readRuntime(value.computerId, signal);
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
        return this.statement(
            database
                .update(runtimeRegistration)
                .set({ agentsJson: agents })
                .where(
                    inArray(
                        runtimeRegistration.generation,
                        database
                            .select({ generation: daemonCredential.generation })
                            .from(daemonCredential)
                            .where(
                                and(
                                    eq(daemonCredential.tokenHash, tokenHash),
                                    inArray(daemonCredential.generation, activeGeneration(computerId)),
                                ),
                            ),
                    ),
                ),
        ).run(signal);
    };
}
