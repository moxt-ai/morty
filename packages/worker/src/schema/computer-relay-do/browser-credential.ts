import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A credential a link issued to a browser. It grants its device's access, which ends with the device
 * (`browser_device.ended_at`) and never on its own; it stops when a newer credential of the same device replaces it.
 */
export const browserCredential = sqliteTable(
    "browser_credential",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        deviceId: text("device_id").notNull(),
        /** The link that issued it; the device's term is the latest among its credentials' links. */
        transferId: text("transfer_id").notNull(),
        createdAt: integer("created_at").notNull(),
        /** When a newer credential of the same device replaced it. */
        replacedAt: integer("replaced_at"),
    },
    (table) => [
        index("browser_credential_device_idx").on(table.deviceId),
        index("browser_credential_transfer_idx").on(table.transferId),
    ],
);
