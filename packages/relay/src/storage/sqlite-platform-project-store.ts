import { relayDrizzle, type SqlDatabase } from "@morty-build/relay-core/database";
import { SqliteProjectStore } from "@morty-build/relay-core/project-store";
import { desc, eq } from "drizzle-orm";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import { platformAuditEvent } from "../schema/project-do/index.ts";

/**
 * A Project's Relay and Platform operations over its own SQLite storage. Only the Account Durable Object
 * constructs this; everything else reaches these tables through its operations.
 */
export class SqlitePlatformProjectStore extends SqliteProjectStore implements PlatformProjectStore {
    readonly #computerId: string;
    readonly #database: SqlDatabase;

    constructor(computerId: string, database: SqlDatabase) {
        super(computerId, database);
        this.#computerId = computerId;
        this.#database = database;
    }

    readonly lastDaemonRevocation = async (signal: AbortSignal): Promise<number | null> => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                "SELECT max(recorded_at) AS cutoff FROM runtime_pairing_audit_events WHERE computer_id = ? AND action = 'runtime_pairing.revoked'",
            )
            .bind(this.#computerId)
            .first<{ cutoff: number | null }>(signal);
        return row?.cutoff ?? null;
    };

    readonly recordAudit: PlatformProjectStore["recordAudit"] = async (audit, signal) => {
        await relayDrizzle(this.#database, signal)
            .insert(platformAuditEvent)
            .values({
                auditId: audit.action === "project.created" ? `pae_created_${this.#computerId}` : audit.auditId,
                appId: audit.appId,
                computerId: this.#computerId,
                actorKind: audit.actorKind,
                actorId: audit.actorId,
                actorRef: audit.actorRef,
                action: audit.action,
                subjectId: audit.subjectId,
                outcome: audit.outcome,
                detailsJson: audit.detailsJson,
                recordedAt: audit.recordedAt,
            })
            .onConflictDoNothing({ target: platformAuditEvent.auditId });
    };

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = async (limit, signal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select()
            .from(platformAuditEvent)
            .where(eq(platformAuditEvent.computerId, this.#computerId))
            .orderBy(desc(platformAuditEvent.recordedAt), desc(platformAuditEvent.auditId))
            .limit(limit);
        return rows.map((row) => ({
            action: row.action,
            actor_id: row.actorId,
            actor_kind: row.actorKind,
            actor_ref: row.actorRef,
            app_id: row.appId,
            audit_id: row.auditId,
            details_json: row.detailsJson,
            outcome: row.outcome,
            project_id: row.computerId,
            recorded_at: row.recordedAt,
            subject_id: row.subjectId,
        }));
    };
}
