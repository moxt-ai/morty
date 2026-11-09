import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Retained records of the retired D1 Session access revocations; Morty no longer reads or writes this table. */
export const machineAccessRevocation = sqliteTable("machine_access_revocations", {
    computerId: text("computer_id").primaryKey(),
    revokedAt: integer("revoked_at").notNull(),
});
