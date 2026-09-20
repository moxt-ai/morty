import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const slackInstallation = sqliteTable(
    "slack_installation",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        tenantId: text("tenant_id").notNull(),
        slackAppRecordId: integer("slack_app_record_id").notNull(),
        slackTeamId: text("slack_team_id").notNull(),
        slackTeamName: text("slack_team_name"),
        slackBotUserId: text("slack_bot_user_id").notNull(),
        botTokenEncrypted: text("bot_token_encrypted").notNull(),
        status: text("status", { enum: ["connected", "token_revoked", "uninstalled", "error"] }).notNull(),
        installedAt: integer("installed_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
        check(
            "slack_installation_status_check",
            sql`${table.status} in ('connected', 'token_revoked', 'uninstalled', 'error')`,
        ),
        unique().on(table.slackAppRecordId, table.slackTeamId),
        index("slack_installation_tenant_idx").on(table.tenantId),
        index("slack_installation_team_idx").on(table.slackTeamId),
        index("slack_installation_bot_user_idx").on(table.slackBotUserId),
    ],
);
