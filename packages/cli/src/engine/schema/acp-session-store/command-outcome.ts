import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The content-free terminal event a settled command recorded, kept for a bounded number of each Session's latest
 * commands. Losing it never changes the command's fate, which its `command` row keeps.
 */
export const commandOutcome = sqliteTable("command_outcome", {
    commandId: text("command_id").primaryKey(),
    outcome: text("outcome").notNull(),
});
