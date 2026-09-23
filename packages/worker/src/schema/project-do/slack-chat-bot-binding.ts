import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackChatBotBinding = sqliteTable(
    "slack_chat_bot_binding",
    {
        tenantId: text("tenant_id").notNull(),
        slackBotId: text("slack_bot_id").notNull(),
        botId: text("bot_id").notNull(),
        connectionId: text("connection_id").notNull(),
        projectId: text("project_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        agentRef: text("agent_ref").notNull(),
        instructions: text("instructions").notNull().default(""),
    },
    (table) => [primaryKey({ columns: [table.tenantId, table.slackBotId] })],
);
