import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The latest time a Project revoked its Session credentials. */
export const machineAccessRevocation = sqliteTable("machine_access_revocations", {
    computerId: text("computer_id").primaryKey(),
    revokedAt: integer("revoked_at").notNull(),
});
