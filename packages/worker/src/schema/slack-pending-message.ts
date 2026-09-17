import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const slackPendingMessage = sqliteTable(
    "slack_pending_message",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        conversationMappingId: integer("conversation_mapping_id").notNull(),
        slackEventId: text("slack_event_id").notNull(),
        payload: text("payload").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        unique().on(table.tenantId, table.slackEventId),
        index("slack_pending_message_conversation_idx").on(
            table.tenantId,
            table.conversationMappingId,
            table.createdAt,
        ),
    ],
);
