import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const identityTransfer = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        userId: text("user_id").notNull(),
        consumedAt: integer("consumed_at"),
        claimNonce: text("claim_nonce"),
        createdAt: integer("created_at").notNull(),
        redemptionCount: integer("redemption_count").notNull().default(0),
        revokedAt: integer("revoked_at"),
    },
    (table) => [check("identity_transfer_redemption_count_check", sql`${table.redemptionCount} between 0 and 5`)],
);
