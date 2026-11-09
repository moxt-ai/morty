import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The computer's daemon credential, rotated on every connection; `tokenHash` authenticates now. */
export const daemonCredential = sqliteTable("daemon_credentials", {
    computerId: text("computer_id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
});

/**
 * Every credential a rotation replaced, with the successor that replaced it, kept for the lifetime of the computer.
 * Presenting a retired credential with any other successor means a copy of it is in use elsewhere.
 */
export const retiredDaemonCredential = sqliteTable(
    "retired_daemon_credentials",
    {
        tokenHash: text("token_hash").primaryKey(),
        computerId: text("computer_id").notNull(),
        successorHash: text("successor_hash").notNull(),
    },
    (table) => [index("retired_daemon_credentials_computer").on(table.computerId)],
);
