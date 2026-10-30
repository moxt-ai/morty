import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const continueLink = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        userId: text("user_id").notNull(),
        expiresAt: integer("expires_at").notNull(),
        claimNonce: text("claim_nonce"),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
    },
    (table) => [index("identity_transfer_expiry_idx").on(table.expiresAt)],
);
