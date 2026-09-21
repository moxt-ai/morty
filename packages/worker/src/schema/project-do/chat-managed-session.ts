import { desc, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatManagedSession = sqliteTable(
    "chat_managed_session",
    {
        projectId: text("project_id").notNull(),
        userId: text("user_id").notNull(),
        botId: text("bot_id").notNull(),
        kind: text("kind", { enum: ["conversation", "fork", "import"] }).notNull(),
        resourceId: text("resource_id").notNull(),
        title: text("title").notNull(),
        forkData: text("fork_data"),
        createdAt: integer("created_at").notNull(),
        archivedAt: integer("archived_at"),
    },
    (table) => [
        check(
            "chat_managed_session_fork_data_check",
            sql`(${table.kind} = 'conversation' and ${table.forkData} is null) or (${table.kind} in ('fork', 'import') and ${table.forkData} is not null)`,
        ),
        primaryKey({ columns: [table.projectId, table.userId, table.botId, table.kind, table.resourceId] }),
        index("chat_managed_session_directory").on(
            table.projectId,
            table.userId,
            table.botId,
            desc(table.createdAt),
            table.resourceId,
        ),
    ],
);
