import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accountObjectIdentity = sqliteTable(
    "machine_account_identity",
    {
        singleton: integer("singleton").primaryKey(),
        accountId: text("project_id").notNull().unique(),
    },
    (table) => [check("machine_account_identity_singleton_check", sql`${table.singleton} = 1`)],
);
