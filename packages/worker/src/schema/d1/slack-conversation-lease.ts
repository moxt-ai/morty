import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackConversationLease = sqliteTable("slack_conversation_lease", {
    conversationKey: text("conversation_key").primaryKey().notNull(),
    owner: text("owner").notNull(),
    expiresAt: integer("expires_at").notNull(),
});
