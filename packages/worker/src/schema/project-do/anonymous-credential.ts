import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const anonymousCredential = sqliteTable(
    "anonymous_credential",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        status: text("status", { enum: ["active", "revoked"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        remoteTransferId: text("remote_transfer_id"),
        /**
         * The browser this credential was issued to, named by the first credential it held: one a browser receives for
         * another link replaces the one it holds and keeps its browser. Null names the credential itself.
         */
        browserId: text("browser_id"),
    },
    (table) => [
        check("anonymous_credential_status_check", sql`${table.status} in ('active', 'revoked')`),
        index("anonymous_credential_user_idx").on(table.userId, table.status),
        index("anonymous_credential_remote_transfer_idx").on(table.remoteTransferId, table.status),
        index("anonymous_credential_browser_idx").on(table.browserId),
    ],
);
