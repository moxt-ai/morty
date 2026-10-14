import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentPairingTicket = sqliteTable("agent_pairing_ticket", {
    codeHash: text("code_hash").primaryKey().notNull(),
    userId: text("user_id").notNull(),
    botId: text("bot_id").notNull(),
    createsBot: integer("creates_bot", { mode: "boolean" }).notNull().default(false),
    expectedRuntimeId: text("expected_runtime_id"),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    claimNonce: text("claim_nonce"),
});
