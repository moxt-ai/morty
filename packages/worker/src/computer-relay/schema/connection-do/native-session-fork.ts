import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Retained records of the Relay's former Fork receipts; nothing reads them. The Computer keeps each Fork's receipt. */
export const nativeSessionFork = sqliteTable(
    "native_session_forks",
    {
        computerId: text("computer_id").notNull(),
        operationId: text("operation_id").notNull(),
        requestHash: text("request_hash").notNull(),
        attemptJson: text("attempt_json"),
        resultJson: text("result_json"),
    },
    (table) => [primaryKey({ columns: [table.computerId, table.operationId] })],
);
