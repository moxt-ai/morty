import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The latest time the computer revoked the Session credentials issued for it. It only moves forward: pairing the
 * computer again never resets it, so a credential issued before an earlier revocation stays refused.
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
