import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** An operation receipt, not a provisional conversation identity. */
export const sessionCreation = sqliteTable("session_creation", {
    operationId: text("operation_id").primaryKey(),
    requestHash: text("request_hash").notNull(),
    resultJson: text("result_json"),
});
