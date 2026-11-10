import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const acpSession = sqliteTable(
    "acp_session",
    {
        harness: text("agent_id").notNull(),
        sessionId: text("session_id").notNull(),
        cwd: text("cwd").notNull(),
        configurations: text("configurations").notNull().default("[]"),
        prompted: integer("prompted", { mode: "boolean" }).notNull(),
        title: text("title").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.harness, table.sessionId] })],
);
