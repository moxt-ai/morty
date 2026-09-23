import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackChatBotBinding = sqliteTable(
    "slack_chat_bot_binding",
    {
        tenantId: text("tenant_id").notNull(),
        slackBotId: text("slack_bot_id").notNull(),
        botId: text("bot_id").notNull(),
        connectionId: text("connection_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.tenantId, table.slackBotId] })],
);
