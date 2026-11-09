import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const chatManagedSession = sqliteTable(
    "chat_managed_session",
    {
        computerId: text("project_id").notNull(),
        userId: text("user_id").notNull(),
        resourceId: text("resource_id").notNull(),
        harness: text("harness"),
        sessionId: text("session_id"),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.computerId, table.userId, table.resourceId] }),
        uniqueIndex("chat_managed_session_native_target").on(
            table.computerId,
            table.userId,
            table.harness,
            table.sessionId,
        ),
        index("chat_managed_session_directory").on(table.computerId, table.userId, table.createdAt, table.resourceId),
    ],
);
