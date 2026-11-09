import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The Projects an AppCredential without all-Project access may use. The credential's own record owns this scope. */
export const machineAccountGrant = sqliteTable(
    "machine_account_grants",
    {
        credentialId: text("credential_id").notNull(),
        computerId: text("computer_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.credentialId, table.computerId] })],
);
