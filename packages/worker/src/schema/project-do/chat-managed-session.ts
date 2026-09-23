import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatManagedSession = sqliteTable(
    "chat_managed_session",
    {
        projectId: text("project_id").notNull(),
        userId: text("user_id").notNull(),
        botId: text("bot_id").notNull(),
        resourceId: text("resource_id").notNull(),
        directoryId: text("directory_id").notNull().default("default"),
        additionalDirectoryIdsJson: text("additional_directory_ids_json").notNull().default("[]"),
        title: text("title").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.projectId, table.userId, table.botId, table.resourceId] }),
        index("chat_managed_session_directory").on(
            table.projectId,
            table.userId,
            table.botId,
            table.createdAt,
            table.resourceId,
        ),
    ],
);
