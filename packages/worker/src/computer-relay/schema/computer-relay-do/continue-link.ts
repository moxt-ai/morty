import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A link the owner shared to add one browser device. It stores what was shared and the owner's own decisions about it;
 * whether it can still add a device follows from those, from its terms, from whether a device used it, and from
 * whether the access that shared it still holds.
 */
export const continueLink = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        /** The original issuance intent, so a retry cannot change an operation's terms or predecessor. */
        requestHash: text("request_hash").notNull(),
        retainedOwnerReference: text("user_id"),
        /** Until when the link can add a device. */
        expiresAt: integer("expires_at").notNull(),
        /** Until when the device the link adds keeps access. A link adds one device: the credential it issued. */
        accessExpiresAt: integer("access_expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
        /** The credential that shared the link; the link adds no device once that credential's access ended. */
        createdByCredentialId: text("created_by_credential_id").notNull(),
        /** The unused link this one replaced when it was shared; a link is replaced at most once. */
        replacesTransferId: text("replaces_transfer_id").unique(),
        /** When the owner cancelled the link's invitation, if they did. */
        cancelledAt: integer("cancelled_at"),
    },
    (table) => [index("identity_transfer_expiry_idx").on(table.expiresAt)],
);
