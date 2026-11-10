import { PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Migration-only declaration: retain service-owned accounts without treating their service IDs as user IDs.
export const retainedMachineAccountTable = sqliteTable(
    "machine_accounts",
    {
        computerId: text("computer_id").primaryKey(),
        appId: text("service_id").notNull(),
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
        unique().on(table.appId, table.idempotencyKey),
        unique().on(table.appId, table.clientReference),
        index("machine_accounts_service").on(table.appId, table.lifecycle, table.createdAt, table.computerId),
    ],
);
