import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const managedBot = sqliteTable(
    "managed_bot",
    {
        userId: text("user_id").notNull(),
        botId: text("bot_id").primaryKey().notNull(),
        displayName: text("display_name").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [index("managed_bot_user_idx").on(table.userId, table.createdAt)],
);
