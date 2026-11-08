import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** The Project this object serves, keyed by its one owner. Deployment settings never name stored state. */
export const platformProjectMapping = sqliteTable(
    "platform_project_mapping",
    {
        userId: text("user_id").primaryKey().notNull(),
        projectId: text("project_id").notNull(),
        displayName: text("display_name").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [unique().on(table.projectId)],
);
