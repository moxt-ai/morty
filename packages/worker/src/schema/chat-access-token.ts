import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatAccessToken = sqliteTable(
    "chat_access_token",
    {
        accessTokenId: text("access_token_id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        botId: text("bot_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [index("chat_access_token_user_idx").on(table.userId, table.createdAt)],
);
