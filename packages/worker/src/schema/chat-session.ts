import { desc } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatSession = sqliteTable(
    "chat_session",
    {
        userId: text("user_id").notNull(),
        sessionId: text("session_id").notNull(),
        botId: text("bot_id").notNull(),
        title: text("title").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.sessionId] }),
        index("chat_session_user_updated_idx").on(table.userId, desc(table.updatedAt)),
    ],
);
