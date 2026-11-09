import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const runtimePairingActions = [
    "runtime_pairing.requested",
    "runtime_pairing.claimed",
    "runtime_pairing.expired",
    "runtime_pairing.revoked",
    "runtime_pairing.rejected",
] as const;

export const runtimePairingAuditEvent = sqliteTable(
    "runtime_pairing_audit_events",
    {
        auditId: text("audit_id").primaryKey(),
        computerId: text("computer_id").notNull(),
        actorKind: text("actor_kind").notNull(),
        actorId: text("actor_id").notNull(),
        action: text("action", { enum: runtimePairingActions }).notNull(),
        detailsJson: text("details_json").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [
        check(
            "runtime_pairing_audit_events_action_check",
            sql`${table.action} in ('runtime_pairing.requested', 'runtime_pairing.claimed', 'runtime_pairing.expired', 'runtime_pairing.revoked', 'runtime_pairing.rejected')`,
        ),
        index("runtime_pairing_audit_project").on(table.computerId, desc(table.recordedAt), desc(table.auditId)),
    ],
);
