import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const relayDashboardAuditEvent = sqliteTable(
    "service_audit_events",
    {
        auditId: text("audit_id").primaryKey(),
        appId: text("service_id").notNull(),
        computerId: text("computer_id").notNull(),
        actorKind: text("actor_kind").notNull(),
        actorId: text("actor_id").notNull(),
        actorRef: text("actor_ref").notNull(),
        action: text("action").notNull(),
        subjectId: text("subject_id").notNull(),
        outcome: text("outcome", { enum: ["succeeded", "denied"] }).notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check("service_audit_events_computer_id_check", sql`${table.computerId} = ''`),
        check("service_audit_events_outcome_check", sql`${table.outcome} in ('succeeded', 'denied')`),
        index("service_audit_events_service").on(table.appId, table.recordedAt, table.auditId),
    ],
);
