import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A credential the computer's owner holds: the computer's own (`local`) or a recovery credential. It grants its own
 * access until it is revoked; revoked access never resumes.
 */
export const ownerCredential = sqliteTable(
    "owner_credential",
    {
        id: text("id").primaryKey().notNull(),
        retainedOwnerReference: text("user_id"),
        tokenHash: text("token_hash").notNull().unique(),
        kind: text("kind", { enum: ["local", "recovery"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [
        index("owner_credential_user_idx").on(table.retainedOwnerReference, table.revokedAt),
        check("owner_credential_kind", sql`${table.kind} IN ('local', 'recovery')`),
    ],
);
