import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Migration-only declaration: preserve historical records without a runtime reader or writer.
export const retainedMachineAccountGrantTable = sqliteTable(
    "machine_account_grants",
    {
        credentialId: text("credential_id").notNull(),
        computerId: text("computer_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.credentialId, table.computerId] })],
);
