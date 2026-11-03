import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A browser that joined the user's computer through a link, described by that first joining. Its credentials carry
 * its access; a browser that opens another link gets a new credential and stays the same device.
 */
export const browserDevice = sqliteTable(
    "browser_device",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        joinedAt: integer("joined_at").notNull(),
        /** How the browser described itself when it joined, so its owner can recognize it; null when it did not. */
        label: text("label"),
        /**
         * Roughly where it joined from, as Cloudflare located the connection: a city and an ISO country code, each null
         * when unknown. The address itself is never kept.
         */
        joinedCity: text("joined_city"),
        joinedCountry: text("joined_country"),
        /** The link it first joined through, which names who added it. */
        joinedThroughTransferId: text("joined_through_transfer_id").notNull(),
    },
    (table) => [index("browser_device_user_idx").on(table.userId)],
);
