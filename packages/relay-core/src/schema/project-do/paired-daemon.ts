import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Identity is allocated before a daemon claims it, so callers can cancel an
// outstanding pairing without manufacturing an empty Runtime registration.
export const pairedDaemon = sqliteTable(
    "runtimes",
    {
        computerId: text("computer_id").primaryKey(),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        revokedByOwnerCredentialId: text("revoked_by_owner_credential_id"),
    },
    (table) => [
        check(
            "runtimes_revoked_at_check",
            sql`${table.revokedAt} is null or (typeof(${table.revokedAt}) = 'integer' and ${table.revokedAt} >= 0)`,
        ),
        check(
            "runtimes_revocation_actor_check",
            sql`${table.revokedByOwnerCredentialId} is null or ${table.revokedAt} is not null`,
        ),
    ],
);
