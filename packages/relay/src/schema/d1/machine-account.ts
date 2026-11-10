import { PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const machineAccount = sqliteTable(
    "machine_accounts",
    {
        computerId: text("computer_id").primaryKey(),
        userId: text("user_id").notNull(),
        displayName: text("display_name").notNull(),
        clientReference: text("client_reference").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        lifecycle: text("lifecycle", { enum: ["active", "deleted"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        deletedAt: integer("deleted_at"),
        locationHint: text("location_hint", { enum: PROJECT_LOCATION_HINTS }).notNull().default("apac"),
    },
    (table) => [
        check("machine_accounts_lifecycle_check", sql`${table.lifecycle} in ('active', 'deleted')`),
        check(
            "machine_accounts_location_hint_check",
            sql`${table.locationHint} in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me')`,
        ),
        unique().on(table.userId, table.idempotencyKey),
        unique().on(table.userId, table.clientReference),
        index("machine_accounts_user").on(table.userId, table.lifecycle, table.createdAt, table.computerId),
    ],
);
