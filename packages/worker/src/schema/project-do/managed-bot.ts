import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The Machine of this Project's one owner: a Project identity is one computer, so it has exactly one Machine. */
export const managedBot = sqliteTable("managed_bot", {
    userId: text("user_id").primaryKey().notNull(),
    botId: text("bot_id").notNull().unique(),
    displayName: text("display_name").notNull(),
    pairingId: text("pairing_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
});
