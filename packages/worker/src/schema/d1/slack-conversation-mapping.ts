import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const slackConversationMapping = sqliteTable(
    "slack_conversation_mapping",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        slackAppRecordId: integer("slack_app_record_id").notNull(),
        slackTeamId: text("slack_team_id").notNull(),
        slackChannelId: text("slack_channel_id").notNull(),
        channelType: text("channel_type", { enum: ["im", "channel", "group", "mpim"] }).notNull(),
        threadTs: text("thread_ts"),
        initiatorSlackUserId: text("initiator_slack_user_id").notNull(),
        conversationId: text("conversation_id").notNull(),
        connectionId: text("connection_id").notNull(),
        metadata: text("metadata"),
        latestEventTs: text("latest_event_ts"),
        lastActiveAt: integer("last_active_at").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "slack_conversation_mapping_channel_type_check",
            sql`${table.channelType} in ('im', 'channel', 'group', 'mpim')`,
        ),
        uniqueIndex("slack_conversation_mapping_thread_idx").on(
            table.tenantId,
            table.slackAppRecordId,
            table.connectionId,
            table.slackChannelId,
            sql`ifnull(${table.threadTs}, '')`,
        ),
        index("slack_conversation_mapping_conversation_idx").on(table.tenantId, table.conversationId),
    ],
);
