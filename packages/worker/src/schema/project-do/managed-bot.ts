import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The Machine of this Project's one owner: a Project identity is one computer, so it has exactly one Machine. Its
 * Runtime pairing is the Relay's record, not a copy here.
 */
export const managedBot = sqliteTable("managed_bot", {
    userId: text("user_id").primaryKey().notNull(),
    createdAt: integer("created_at").notNull(),
});
