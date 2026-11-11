import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { relayDrizzle, type SqlDatabase } from "@morty-build/relay-core/database";
import { SqliteProjectStore } from "@morty-build/relay-core/project-store";
import { auditEvent } from "@morty-build/relay-core/schema/project-do";
import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { AuditRowSchema } from "../entity/relay-records.ts";
import type { ComputerManagementStore } from "../infra/computer-management-store.ts";

/**
 * A Project's Relay and Relay operations over its own SQLite storage. Only the Account Durable Object
 * constructs this; everything else reaches these tables through its operations.
 */
export class SqliteComputerManagementStore extends SqliteProjectStore implements ComputerManagementStore {
    readonly #computerId: string;
    readonly #database: SqlDatabase;

    /** `holdsAccess` answers, from the computer's identities, whether a holder's access to the computer still holds. */
    constructor(
        computerId: string,
        database: SqlDatabase,
        holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>,
    ) {
        super(computerId, database);
        this.#computerId = computerId;
        this.#database = database;
        this.holdsAccess = holdsAccess;
    }

    readonly holdsAccess: ComputerManagementStore["holdsAccess"];

    readonly recordAudit: ComputerManagementStore["recordAudit"] = async (audit, signal) => {
        await relayDrizzle(this.#database, signal)
            .insert(auditEvent)
            .values({
                auditId: audit.action === "project.created" ? `pae_created_${this.#computerId}` : audit.auditId,
                category: "computer_management",
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

    readonly listAuditEvents: ComputerManagementStore["listAuditEvents"] = async (limit, signal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select()
            .from(auditEvent)
            .where(and(eq(auditEvent.category, "computer_management"), eq(auditEvent.computerId, this.#computerId)))
            .orderBy(desc(auditEvent.recordedAt), desc(auditEvent.auditId))
            .limit(limit);
        return rows.map((row) =>
            v.parse(AuditRowSchema, {
                action: row.action,
                actor_id: row.actorId,
                actor_kind: row.actorKind,
                actor_ref: row.actorRef,
                audit_id: row.auditId,
                details_json: row.detailsJson,
                outcome: row.outcome,
                computer_id: row.computerId,
                recorded_at: row.recordedAt,
                subject_id: row.subjectId,
            }),
        );
    };
}
