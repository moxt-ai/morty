import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const computerObjectIdentity = sqliteTable(
    "machine_account_identity",
    {
        singleton: integer("singleton").primaryKey(),
        computerId: text("project_id").notNull().unique(),
    },
    (table) => [check("machine_account_identity_singleton_check", sql`${table.singleton} = 1`)],
);
