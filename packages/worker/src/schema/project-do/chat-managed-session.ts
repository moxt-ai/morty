import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatManagedSession = sqliteTable(
    "chat_managed_session",
    {
        accountId: text("project_id").notNull(),
        userId: text("user_id").notNull(),
        botId: text("bot_id").notNull(),
        resourceId: text("resource_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.accountId, table.userId, table.botId, table.resourceId] }),
        index("chat_managed_session_directory").on(
            table.accountId,
            table.userId,
            table.botId,
            table.createdAt,
            table.resourceId,
        ),
    ],
);
