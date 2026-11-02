import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const continueLink = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        userId: text("user_id").notNull(),
        /** Until when the link can add a device. */
        expiresAt: integer("expires_at").notNull(),
        /** Until when the device the link adds keeps access. Links issued before devices had their own term have none. */
        accessExpiresAt: integer("access_expires_at").notNull().default(0),
        /** A link adds one device: set when it does. */
        redeemedAt: integer("redeemed_at"),
        claimNonce: text("claim_nonce"),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        /** The credential that shared the link; links shared before this was recorded have none. */
        createdByCredentialId: text("created_by_credential_id"),
    },
    (table) => [index("identity_transfer_expiry_idx").on(table.expiresAt)],
);
