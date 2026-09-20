import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const processedSlackEvent = sqliteTable(
    "processed_slack_event",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        slackEventId: text("slack_event_id").notNull(),
        slackAppId: text("slack_app_id").notNull(),
        slackTeamId: text("slack_team_id").notNull(),
        payload: text("payload").notNull(),
        status: text("status", { enum: ["pending", "processing", "processed", "failed"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        processedAt: integer("processed_at"),
    },
    (table) => [
        check(
            "processed_slack_event_status_check",
            sql`${table.status} in ('pending', 'processing', 'processed', 'failed')`,
        ),
        unique().on(table.slackAppId, table.slackEventId),
        index("processed_slack_event_pending_idx").on(table.status, table.createdAt),
        index("processed_slack_event_tenant_event_idx").on(table.tenantId, table.slackEventId),
    ],
);
