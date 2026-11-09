import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A Runtime daemon's relay credential, rotated on every connection; `tokenHash` authenticates now. */
export const runtimeDaemonCredential = sqliteTable("runtime_daemon_credentials", {
    runtimeId: text("runtime_id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
});

/**
 * Every credential a rotation replaced, with the successor that replaced it, kept for as long as its Runtime.
 * Presenting a retired credential with any other successor means a copy of it is in use elsewhere.
 */
export const runtimeDaemonRetiredCredential = sqliteTable(
    "runtime_daemon_retired_credentials",
    {
        tokenHash: text("token_hash").primaryKey(),
        runtimeId: text("runtime_id").notNull(),
        successorHash: text("successor_hash").notNull(),
    },
    (table) => [index("runtime_daemon_retired_credentials_runtime").on(table.runtimeId)],
);
