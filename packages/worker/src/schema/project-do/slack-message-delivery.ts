import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackMessageDelivery = sqliteTable(
    "slack_message_delivery",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        clientMessageId: text("client_message_id").notNull().unique(),
        conversationMappingId: integer("conversation_mapping_id").notNull(),
        replyThreadTs: text("reply_thread_ts"),
        statusThreadTs: text("status_thread_ts"),
        triggerSenderInfo: text("trigger_sender_info"),
        deliveryStatus: text("delivery_status", { enum: ["pending", "delivering", "completed"] })
            .notNull()
            .default("pending"),
        deliveryAttempts: integer("delivery_attempts").notNull().default(0),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "slack_message_delivery_status_check",
            sql`${table.deliveryStatus} in ('pending', 'delivering', 'completed')`,
        ),
        index("slack_message_delivery_conversation_idx").on(table.conversationMappingId),
    ],
);
