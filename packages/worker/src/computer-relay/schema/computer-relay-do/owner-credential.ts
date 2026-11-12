import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The computer's own credential. It grants its own access until it is revoked; revoked access never resumes. */
export const ownerCredential = sqliteTable(
    "owner_credential",
    {
        id: text("id").primaryKey().notNull(),
        retainedOwnerReference: text("user_id"),
        tokenHash: text("token_hash").notNull().unique(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [index("owner_credential_user_idx").on(table.retainedOwnerReference, table.revokedAt)],
);
