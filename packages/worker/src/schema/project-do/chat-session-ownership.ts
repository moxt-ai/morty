import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Ownership survives removal from Recent sessions so only the original owner can reopen a closed session. */
export const chatSessionOwnership = sqliteTable(
    "chat_session_ownership",
    {
        projectId: text("project_id").notNull(),
        userId: text("user_id").notNull(),
        botId: text("bot_id").notNull(),
        sessionId: text("session_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.projectId, table.userId, table.botId, table.sessionId] })],
);
