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
         * The credential that replaced this one when the same browser opened another link. Ending that credential's
         * access ends the links this one came from too.
         */
        supersededBy: text("superseded_by"),
    },
    (table) => [
        check("anonymous_credential_status_check", sql`${table.status} in ('active', 'revoked')`),
        index("anonymous_credential_user_idx").on(table.userId, table.status),
        index("anonymous_credential_remote_transfer_idx").on(table.remoteTransferId, table.status),
        index("anonymous_credential_superseded_by_idx").on(table.supersededBy),
    ],
);
