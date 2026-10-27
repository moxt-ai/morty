import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const platformProjectMapping = sqliteTable(
    "platform_project_mapping",
    {
        userId: text("user_id").notNull(),
        appId: text("app_id").notNull(),
        projectId: text("project_id").notNull(),
        displayName: text("display_name").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.appId] }), unique().on(table.projectId)],
);
