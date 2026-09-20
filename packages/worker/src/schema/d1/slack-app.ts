import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const slackApp = sqliteTable(
    "slack_app",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        slackBotId: text("slack_bot_id").notNull(),
        slackAppId: text("slack_app_id").notNull().unique(),
        slackClientId: text("slack_client_id").notNull(),
        clientSecretEncrypted: text("client_secret_encrypted").notNull(),
        signingSecretEncrypted: text("signing_secret_encrypted").notNull(),
        oauthRedirectUri: text("oauth_redirect_uri").notNull(),
        appName: text("app_name").notNull(),
        status: text("status", { enum: ["enabled", "disabled"] }).notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check("slack_app_status_check", sql`${table.status} in ('enabled', 'disabled')`),
        unique().on(table.tenantId, table.slackBotId),
        index("slack_app_tenant_idx").on(table.tenantId),
    ],
);
