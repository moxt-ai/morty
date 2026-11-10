import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvent = sqliteTable(
    "audit_events",
    {
        category: text("category", { enum: ["authentication", "pairing", "computer_management"] }).notNull(),
        auditId: text("audit_id").notNull(),
        computerId: text("computer_id").notNull(),
        actorKind: text("actor_kind").notNull(),
        actorId: text("actor_id").notNull(),
        action: text("action").notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
        actorRef: text("actor_ref"),
        // Retained historical attribution; new audit events identify the user through actorId.
        historicalServiceId: text("service_id"),
        subjectId: text("subject_id"),
        outcome: text("outcome", { enum: ["succeeded", "denied"] }),
    },
    (t) => [
        primaryKey({ columns: [t.category, t.auditId] }),
        check("audit_event_category", sql`${t.category} in ('authentication','pairing','computer_management')`),
        check(
            "audit_event_computer_management",
            sql`${t.category} != 'computer_management' or (${t.actorRef} is not null and ${t.subjectId} is not null and ${t.outcome} is not null)`,
        ),
        index("audit_events_category_time").on(t.category, sql`${t.recordedAt} desc`, sql`${t.auditId} desc`),
    ],
);
