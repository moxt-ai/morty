import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Retained records of the retired link-sharing model; Morty no longer reads or writes this table. */
export const channelAccessGrant = sqliteTable(
    "channel_access_grants",
    {
        grantId: text("grant_id").primaryKey(),
        computerId: text("computer_id").notNull(),
        secretHash: text("secret_hash").notNull(),
        createdByCredentialId: text("created_by_credential_id").notNull(),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
        redeemedAt: integer("redeemed_at"),
        redeemedCredentialId: text("redeemed_credential_id"),
    },
    (table) => [index("channel_access_grants_channel").on(table.computerId, table.createdAt)],
);
