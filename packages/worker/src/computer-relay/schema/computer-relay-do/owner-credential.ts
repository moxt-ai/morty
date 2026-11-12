import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The computer's own credential. It grants its own access until it is revoked; revoked access never resumes. */
export const ownerCredential = sqliteTable("owner_credential", {
    id: text("id").primaryKey().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    revokedAt: integer("revoked_at"),
});
