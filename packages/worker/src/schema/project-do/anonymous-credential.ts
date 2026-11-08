import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A secret that authenticates its user. The machine's own and recovery credentials grant access until revoked. A browser
 * credential grants its device's access: it stops when a newer credential of the same device replaces it, and its access
 * ends with its device's (`browser_device.ended_at`), never on its own.
 */
export const anonymousCredential = sqliteTable(
    "anonymous_credential",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        kind: text("kind", { enum: ["local", "browser", "recovery"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        /** When the machine's own or a recovery credential was revoked. */
        revokedAt: integer("revoked_at"),
        /** When a newer credential of the same browser device replaced this browser credential. */
        replacedAt: integer("replaced_at"),
        /** The link that issued a browser credential; the device's term is the latest among its credentials' links. */
        remoteTransferId: text("remote_transfer_id"),
        /** The browser device a browser credential belongs to; null for the machine's own and recovery credentials. */
        deviceId: text("device_id"),
    },
    (table) => [
        index("anonymous_credential_user_idx").on(table.userId, table.revokedAt),
        index("anonymous_credential_remote_transfer_idx").on(table.remoteTransferId),
        index("anonymous_credential_device_idx").on(table.deviceId),
        check("anonymous_credential_kind", sql`${table.kind} IN ('local', 'browser', 'recovery')`),
        // Exactly the browser credentials came through a link and belong to a device.
        check("anonymous_credential_device_kind", sql`(${table.kind} = 'browser') = (${table.deviceId} IS NOT NULL)`),
        check(
            "anonymous_credential_transfer_kind",
            sql`(${table.kind} = 'browser') = (${table.remoteTransferId} IS NOT NULL)`,
        ),
        // A browser credential is replaced rather than revoked; the others are revoked and never replaced.
        check("anonymous_credential_revoked_kind", sql`${table.kind} <> 'browser' OR ${table.revokedAt} IS NULL`),
        check("anonymous_credential_replaced_kind", sql`${table.kind} = 'browser' OR ${table.replacedAt} IS NULL`),
    ],
);
