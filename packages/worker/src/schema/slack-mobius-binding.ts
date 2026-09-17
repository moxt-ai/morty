import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackMobiusBinding = sqliteTable(
    "slack_mobius_binding",
    {
        tenantId: text("tenant_id").notNull(),
        slackBotId: text("slack_bot_id").notNull(),
        botId: text("bot_id").notNull(),
        connectionId: text("connection_id").notNull(),
        deliveryTargetId: text("delivery_target_id").notNull(),
        credentialEncrypted: text("credential_encrypted").notNull(),
    },
    (table) => [primaryKey({ columns: [table.tenantId, table.slackBotId] })],
);
