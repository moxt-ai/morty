import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const anonymousCredential = sqliteTable(
    "anonymous_credential",
    {
        id: text("id").primaryKey().notNull(),
        userId: text("user_id").notNull(),
        tokenHash: text("token_hash").notNull().unique(),
        // Null is an unclassified legacy credential, never an assumption of local authority.
        kind: text("kind", { enum: ["local", "browser", "recovery"] }),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        remoteTransferId: text("remote_transfer_id"),
        /**
         * The browser this credential was issued to, named by the first credential it held: one a browser receives for
         * another link replaces the one it holds and keeps its browser. Null names the credential itself.
         */
        browserId: text("browser_id"),
        /** How the browser described itself when it joined, so its owner can recognize it; null when it did not. */
        deviceLabel: text("device_label"),
    },
    (table) => [
        index("anonymous_credential_user_idx").on(table.userId, table.revokedAt),
        index("anonymous_credential_remote_transfer_idx").on(table.remoteTransferId, table.revokedAt),
        index("anonymous_credential_browser_idx").on(table.browserId),
    ],
);
