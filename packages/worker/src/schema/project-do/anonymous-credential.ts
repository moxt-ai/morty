import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const anonymousCredential = sqliteTable(
    "anonymous_credential",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        kind: text("kind", { enum: ["local", "browser", "recovery"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        /** The link that issued a browser credential, whose term bounds its access. */
        remoteTransferId: text("remote_transfer_id"),
        /** The browser device a browser credential belongs to; null for the machine's own and recovery credentials. */
        deviceId: text("device_id"),
    },
    (table) => [
        index("anonymous_credential_user_idx").on(table.userId, table.revokedAt),
        index("anonymous_credential_remote_transfer_idx").on(table.remoteTransferId, table.revokedAt),
        index("anonymous_credential_device_idx").on(table.deviceId),
        check("anonymous_credential_kind", sql`${table.kind} IN ('local', 'browser', 'recovery')`),
        // Exactly the browser credentials came through a link and belong to a device.
        check("anonymous_credential_device_kind", sql`(${table.kind} = 'browser') = (${table.deviceId} IS NOT NULL)`),
        check(
            "anonymous_credential_transfer_kind",
            sql`(${table.kind} = 'browser') = (${table.remoteTransferId} IS NOT NULL)`,
        ),
    ],
);
