import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const slackUserConfigToken = sqliteTable(
    "slack_user_config_token",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        humanId: text("human_id").notNull(),
        accessTokenEncrypted: text("access_token_encrypted").notNull(),
        refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
        expiresAt: integer("expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [unique().on(table.tenantId, table.humanId)],
);
