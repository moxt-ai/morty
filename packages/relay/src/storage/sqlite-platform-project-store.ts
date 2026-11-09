import { relayDrizzle, type SqlDatabase } from "@morty-build/relay-core/database";
import { SqliteProjectStore } from "@morty-build/relay-core/project-store";
import { auditEvent } from "@morty-build/relay-core/schema/project-do";
import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { AuditRowSchema } from "../entity/platform-records.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";

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
                "SELECT max(recorded_at) AS cutoff FROM audit_events WHERE category = 'pairing' AND computer_id = ? AND action = 'runtime_pairing.revoked'",
            )
            .bind(this.#computerId)
            .first<{ cutoff: number | null }>(signal);
        return row?.cutoff ?? null;
    };

    readonly recordAudit: PlatformProjectStore["recordAudit"] = async (audit, signal) => {
        await relayDrizzle(this.#database, signal)
            .insert(auditEvent)
            .values({
                auditId: audit.action === "project.created" ? `pae_created_${this.#computerId}` : audit.auditId,
                category: "platform",
                serviceId: audit.appId,
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
            .onConflictDoNothing();
    };

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = async (limit, signal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select()
            .from(auditEvent)
            .where(and(eq(auditEvent.category, "platform"), eq(auditEvent.computerId, this.#computerId)))
            .orderBy(desc(auditEvent.recordedAt), desc(auditEvent.auditId))
            .limit(limit);
        return rows.map((row) =>
            v.parse(AuditRowSchema, {
                action: row.action,
                actor_id: row.actorId,
                actor_kind: row.actorKind,
                actor_ref: row.actorRef,
                app_id: row.serviceId,
                audit_id: row.auditId,
                details_json: row.detailsJson,
                outcome: row.outcome,
                project_id: row.computerId,
                recorded_at: row.recordedAt,
                subject_id: row.subjectId,
            }),
        );
    };
}
