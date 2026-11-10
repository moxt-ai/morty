import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Retained records of when a computer last revoked its Session credentials. Nothing reads or writes them: a Session
 * credential is now honored only while the access of its holder still holds.
 */
export const sessionAccessRevocation = sqliteTable(
    "session_access_revocations",
    {
        computerId: text("computer_id").primaryKey(),
        revokedAt: integer("revoked_at").notNull(),
    },
    (table) => [
        check(
            "session_access_revocations_revoked_at_check",
            sql`typeof(${table.revokedAt}) = 'integer' and ${table.revokedAt} >= 0`,
        ),
    ],
);
