import * as v from "valibot";
import type { SlackConversationInput, SlackConversationKey, SlackMessageReplyContext } from "../entity/conversation";
import { type SlackEventCallbackPayload, slackEventCallbackPayloadSchema } from "../entity/events";
import type {
    BotSlackInstallation,
    ManagedSlackApp,
    ManagedSlackInstallation,
    SlackAppConfiguration,
    SlackInstallationRecord,
} from "../entity/installation";
import type { TenantContext } from "../entity/tenant-context";
import type { DatabaseResolver } from "../infra/database-resolver";
import { queueMessageSchema, type SecretCipher } from "../infra/index";
import type { SlackQueue } from "../infra/slack-queue";
import type { StoredSlackConversation, StoredSlackEventTarget } from "./slack-event-records";

const appRowSchema = v.object({
    slack_bot_id: v.string(),
    app_name: v.string(),
    client_secret_encrypted: v.string(),
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    oauth_redirect_uri: v.string(),
    slack_app_id: v.string(),
    slack_client_id: v.string(),
    status: v.picklist(["enabled", "disabled"]),
    tenant_id: v.string(),
});

const installationRowSchema = v.object({
    bot_token_encrypted: v.string(),
    slack_app_record_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    slack_bot_user_id: v.string(),
    slack_team_id: v.string(),
    slack_team_name: v.nullable(v.string()),
    status: v.picklist(["connected", "error", "token_revoked", "uninstalled"]),
    tenant_id: v.string(),
});

const configTokenRowSchema = v.object({
    access_token_encrypted: v.string(),
    expires_at: v.pipe(v.number(), v.safeInteger()),
    refresh_token_encrypted: v.string(),
});

const stringRowSchema = v.object({ value: v.string() });
const countRowSchema = v.object({ count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) });

const messageDeliveryRowSchema = v.object({
    bot_token_encrypted: v.string(),
    reply_thread_ts: v.nullable(v.string()),
    conversation_mapping_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    slack_channel_id: v.string(),
    status_thread_ts: v.nullable(v.string()),
    tenant_id: v.string(),
});

const eventTargetRowSchema = v.object({
    slack_bot_id: v.string(),
    bot_token_encrypted: v.string(),
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    slack_bot_user_id: v.string(),
    slack_team_id: v.string(),
    tenant_id: v.string(),
});

const conversationRowSchema = v.object({
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    latest_event_ts: v.nullable(v.string()),
    conversation_id: v.string(),
});

export class SlackEventStorage {
    readonly eventNeedsProcessing = async (
        tenant: TenantContext,
        tenantId: string,
        eventId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const row = await this.#first(
            tenant,
            "SELECT status FROM processed_slack_event WHERE tenant_id = ?1 AND slack_event_id = ?2",
            [tenantId, eventId],
            signal,
        );
        return row !== null && v.parse(v.object({ status: v.string() }), row).status !== "processed";
    };
    readonly releaseMessageDelivery = async (
        tenant: TenantContext,
        tenantId: string,
        clientMessageId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            "UPDATE slack_message_delivery SET delivery_status = 'pending' WHERE tenant_id = ?1 AND client_message_id = ?2 AND delivery_status = 'delivering'",
            [tenantId, clientMessageId],
            signal,
        );
    };
    readonly prepareMessageDelivery = async (
        tenant: TenantContext,
        input: {
            readonly conversation: SlackConversationInput;
            readonly conversationId: string;
            readonly connectionId: string;
            readonly clientMessageId: string;
            readonly slackAppRecordId: number;
            readonly slackTeamId: string;
            readonly latestEventTs: string;
        },
        signal: AbortSignal,
    ): Promise<StoredSlackConversation> => {
        const c = input.conversation;
        const now = Date.now();
        const selectConversation =
            "SELECT id FROM slack_conversation_mapping WHERE tenant_id = ?1 AND conversation_id = ?3";
        await this.#database.resolve().batch(
            [
                {
                    query: `INSERT INTO slack_conversation_mapping (tenant_id, slack_app_record_id, slack_team_id, slack_channel_id, channel_type, thread_ts, initiator_slack_user_id, conversation_id, latest_event_ts, last_active_at, created_at, updated_at, connection_id)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11)
                ON CONFLICT DO UPDATE SET latest_event_ts = excluded.latest_event_ts, last_active_at = excluded.last_active_at, updated_at = excluded.updated_at`,
                    values: [
                        c.tenantId,
                        input.slackAppRecordId,
                        input.slackTeamId,
                        c.channelId,
                        c.channelId.startsWith("D") ? "im" : "channel",
                        c.threadTs,
                        c.sender.kind === "user" ? c.sender.slackUserId : c.sender.slackBotId,
                        input.conversationId,
                        input.latestEventTs,
                        now,
                        input.connectionId,
                    ],
                },
                {
                    query: `INSERT INTO slack_message_delivery (tenant_id, client_message_id, conversation_mapping_id, reply_thread_ts, status_thread_ts, trigger_sender_info, created_at, updated_at)
                VALUES (?1, ?2, (${selectConversation}), ?4, ?4, ?5, ?6, ?6)`,
                    values: [
                        c.tenantId,
                        input.clientMessageId,
                        input.conversationId,
                        c.threadTs,
                        JSON.stringify(c.sender),
                        now,
                    ],
                },
            ],
            signal,
        );
        const conversation = await this.findConversation(tenant, c, signal, input.connectionId);
        if (conversation === null) {
            throw new Error("Prepared conversation is missing");
        }
        return conversation;
    };
    readonly acquireConversation = async (
        tenant: TenantContext,
        key: string,
        owner: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const now = Date.now();
        const result = await this.#run(
            tenant,
            `INSERT INTO slack_conversation_lease (conversation_key, owner, expires_at)
            VALUES (?1, ?2, ?3) ON CONFLICT(conversation_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
            WHERE slack_conversation_lease.expires_at <= ?4`,
            [key, owner, now + 660_000, now],
            signal,
        );
        return result.meta.changes === 1;
    };
    readonly releaseConversation = async (
        tenant: TenantContext,
        key: string,
        owner: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            "DELETE FROM slack_conversation_lease WHERE conversation_key = ?1 AND owner = ?2",
            [key, owner],
            signal,
        );
    };
    readonly findEvent = async (
        tenant: TenantContext,
        eventId: string,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<SlackEventCallbackPayload | null> => {
        const row = await this.#first(
            tenant,
            "SELECT payload FROM processed_slack_event WHERE slack_event_id = ?1 AND tenant_id = ?2 AND payload != ''",
            [eventId, tenantId],
            signal,
        );
        if (row === null) {
            return null;
        }
        return v.parse(
            slackEventCallbackPayloadSchema,
            JSON.parse(v.parse(v.object({ payload: v.string() }), row).payload),
        );
    };
    readonly #database: DatabaseResolver;
    readonly #cipher: SecretCipher;
    readonly #events: SlackQueue;

    constructor(cx: {
        readonly gateways: {
            readonly databaseResolver: DatabaseResolver;
            readonly secretEncryption: SecretCipher;
            readonly queue: SlackQueue;
        };
    }) {
        const { databaseResolver: databases, secretEncryption: cipher, queue: events } = cx.gateways;
        this.#database = databases;
        this.#cipher = cipher;
        this.#events = events;
    }

    readonly findSigningSecret = async (
        tenant: TenantContext,
        slackAppId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        const row = await this.#first(
            tenant,
            "SELECT signing_secret_encrypted FROM slack_app WHERE slack_app_id = ?1 AND status = 'enabled'",
            [slackAppId],
            signal,
        );
        if (row === null) {
            return null;
        }
        return await this.#cipher.decrypt(
            v.parse(v.object({ signing_secret_encrypted: v.string() }), row).signing_secret_encrypted,
            signal,
        );
    };

    readonly findTenantIdBySlackAppId = async (
        tenant: TenantContext,
        slackAppId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        const row = await this.#first(
            tenant,
            "SELECT tenant_id FROM slack_app WHERE slack_app_id = ?1 AND status = 'enabled'",
            [slackAppId],
            signal,
        );
        return row === null ? null : v.parse(v.object({ tenant_id: v.string() }), row).tenant_id;
    };

    readonly insertEvent = async (
        tenant: TenantContext,
        tenantId: string,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await this.#run(
            tenant,
            `INSERT OR IGNORE INTO processed_slack_event
            (tenant_id, slack_event_id, slack_app_id, slack_team_id, payload, status, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)`,
            [tenantId, payload.event_id, payload.api_app_id, payload.team_id, JSON.stringify(payload), Date.now()],
            signal,
        );
        return result.meta.changes === 1;
    };

    readonly findApp = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<ManagedSlackApp | null> => {
        const row = await this.#first(
            tenant,
            `SELECT id, tenant_id, slack_bot_id, app_name, slack_app_id,
                    slack_client_id, client_secret_encrypted, oauth_redirect_uri, status
               FROM slack_app
              WHERE tenant_id = ?1 AND slack_bot_id = ?2`,
            [tenantId, botId],
            signal,
        );
        if (row === null) {
            return null;
        }
        const app = v.parse(appRowSchema, row);
        return {
            botId: app.slack_bot_id,
            appName: app.app_name,
            clientId: app.slack_client_id,
            id: app.id,
            slackAppId: app.slack_app_id,
            status: app.status,
            tenantId: app.tenant_id,
        };
    };

    readonly findEnabledAppConfiguration = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<SlackAppConfiguration | null> => {
        const row = await this.#first(
            tenant,
            `SELECT id, tenant_id, slack_bot_id, app_name, slack_app_id,
                    slack_client_id, client_secret_encrypted, oauth_redirect_uri, status
               FROM slack_app
              WHERE tenant_id = ?1 AND slack_bot_id = ?2 AND status = 'enabled'`,
            [tenantId, botId],
            signal,
        );
        if (row === null) {
            return null;
        }
        const app = v.parse(appRowSchema, row);
        return {
            botId: app.slack_bot_id,
            clientId: app.slack_client_id,
            clientSecretEncrypted: app.client_secret_encrypted,
            id: app.id,
            oauthRedirectUri: app.oauth_redirect_uri,
            tenantId: app.tenant_id,
        };
    };

    readonly registerApp = async (
        tenant: TenantContext,
        input: {
            readonly botId: string;
            readonly appName: string;
            readonly clientId: string;
            readonly clientSecretEncrypted: string;
            readonly oauthRedirectUri: string;
            readonly signingSecretEncrypted: string;
            readonly slackAppId: string;
            readonly tenantId: string;
            readonly timestamp: number;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `INSERT INTO slack_app
                (tenant_id, slack_bot_id, slack_app_id, slack_client_id,
                 client_secret_encrypted, signing_secret_encrypted,
                 oauth_redirect_uri, app_name, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'enabled', ?9, ?9)
             ON CONFLICT(tenant_id, slack_bot_id) DO UPDATE SET
                 slack_app_id = excluded.slack_app_id,
                 slack_client_id = excluded.slack_client_id,
                 client_secret_encrypted = excluded.client_secret_encrypted,
                 signing_secret_encrypted = excluded.signing_secret_encrypted,
                 oauth_redirect_uri = excluded.oauth_redirect_uri,
                 app_name = excluded.app_name,
                 status = 'enabled',
                 updated_at = excluded.updated_at`,
            [
                input.tenantId,
                input.botId,
                input.slackAppId,
                input.clientId,
                input.clientSecretEncrypted,
                input.signingSecretEncrypted,
                input.oauthRedirectUri,
                input.appName,
                input.timestamp,
            ],
            signal,
        );
    };

    readonly disableApp = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            "UPDATE slack_app SET status = 'disabled', updated_at = ?3 WHERE tenant_id = ?1 AND slack_bot_id = ?2",
            [tenantId, botId, Date.now()],
            signal,
        );
    };

    readonly findInstallationByTeamAndApp = async (
        tenant: TenantContext,
        slackTeamId: string,
        slackAppRecordId: number,
        signal: AbortSignal,
    ): Promise<SlackInstallationRecord | null> => {
        const value = await this.#installation(
            tenant,
            "WHERE slack_team_id = ?1 AND slack_app_record_id = ?2",
            [slackTeamId, slackAppRecordId],
            signal,
        );
        return value === null
            ? null
            : {
                  slackAppRecordId: value.slack_app_record_id,
                  slackTeamId: value.slack_team_id,
                  tenantId: value.tenant_id,
              };
    };

    readonly findLatestInstallation = async (
        tenant: TenantContext,
        tenantId: string,
        slackAppRecordId: number,
        signal: AbortSignal,
    ): Promise<ManagedSlackInstallation | null> => {
        const value = await this.#installation(
            tenant,
            "WHERE tenant_id = ?1 AND slack_app_record_id = ?2 ORDER BY updated_at DESC LIMIT 1",
            [tenantId, slackAppRecordId],
            signal,
        );
        return value === null
            ? null
            : {
                  slackTeamId: value.slack_team_id,
                  slackTeamName: value.slack_team_name,
                  status: value.status,
              };
    };

    readonly upsertInstallation = async (
        tenant: TenantContext,
        input: {
            readonly botTokenEncrypted: string;
            readonly installedAt: number;
            readonly slackAppRecordId: number;
            readonly slackBotUserId: string;
            readonly slackTeamId: string;
            readonly slackTeamName: string | null;
            readonly tenantId: string;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `INSERT INTO slack_installation
                (tenant_id, slack_app_record_id, slack_team_id, slack_team_name,
                 slack_bot_user_id, bot_token_encrypted, status, installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'connected', ?7, ?7)
             ON CONFLICT(slack_app_record_id, slack_team_id) DO UPDATE SET
                 tenant_id = excluded.tenant_id,
                 slack_team_name = excluded.slack_team_name,
                 slack_bot_user_id = excluded.slack_bot_user_id,
                 bot_token_encrypted = excluded.bot_token_encrypted,
                 status = 'connected',
                 installed_at = excluded.installed_at,
                 updated_at = excluded.updated_at`,
            [
                input.tenantId,
                input.slackAppRecordId,
                input.slackTeamId,
                input.slackTeamName,
                input.slackBotUserId,
                input.botTokenEncrypted,
                input.installedAt,
            ],
            signal,
        );
    };

    readonly uninstallInstallation = async (
        tenant: TenantContext,
        tenantId: string,
        slackAppRecordId: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `UPDATE slack_installation
                SET status = 'uninstalled', updated_at = ?3
              WHERE tenant_id = ?1 AND slack_app_record_id = ?2`,
            [tenantId, slackAppRecordId, Date.now()],
            signal,
        );
    };

    readonly markInstallationStatusByApp = async (
        tenant: TenantContext,
        slackAppId: string,
        status: "token_revoked" | "uninstalled",
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `UPDATE slack_installation
                SET status = ?2, updated_at = ?3
              WHERE slack_app_record_id = (SELECT id FROM slack_app WHERE slack_app_id = ?1)`,
            [slackAppId, status, Date.now()],
            signal,
        );
    };

    readonly findTargetForPayload = async (
        tenant: TenantContext,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<StoredSlackEventTarget | null> => {
        const row = await this.#first(
            tenant,
            `SELECT a.id, a.tenant_id, a.slack_bot_id,
                    i.slack_team_id, i.slack_bot_user_id, i.bot_token_encrypted
               FROM slack_app a
               JOIN slack_installation i ON i.slack_app_record_id = a.id
              WHERE a.slack_app_id = ?1 AND i.slack_team_id = ?2
                AND a.status = 'enabled' AND i.status = 'connected'`,
            [payload.api_app_id, payload.team_id],
            signal,
        );
        return await this.#eventTarget(row, signal);
    };

    readonly findTargetForBot = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<StoredSlackEventTarget | null> => {
        const row = await this.#first(
            tenant,
            `SELECT a.id, a.tenant_id, a.slack_bot_id,
                    i.slack_team_id, i.slack_bot_user_id, i.bot_token_encrypted
               FROM slack_app a
               JOIN slack_installation i ON i.slack_app_record_id = a.id
              WHERE a.tenant_id = ?1 AND a.slack_bot_id = ?2
                AND a.status = 'enabled' AND i.status = 'connected'
              ORDER BY i.updated_at DESC LIMIT 1`,
            [tenantId, botId],
            signal,
        );
        return await this.#eventTarget(row, signal);
    };

    readonly findSourceBot = async (
        tenant: TenantContext,
        tenantId: string,
        slackAppId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        const row = await this.#first(
            tenant,
            `SELECT slack_bot_id AS value FROM slack_app
              WHERE tenant_id = ?1 AND slack_app_id = ?2 AND status = 'enabled'`,
            [tenantId, slackAppId],
            signal,
        );
        return row === null ? null : v.parse(stringRowSchema, row).value;
    };

    readonly findConversation = async (
        tenant: TenantContext,
        input: SlackConversationKey,
        signal: AbortSignal,
        connectionId?: string,
    ): Promise<StoredSlackConversation | null> => {
        const row = await this.#first(
            tenant,
            `SELECT s.id, s.conversation_id, s.latest_event_ts
               FROM slack_conversation_mapping s
               JOIN slack_app a ON a.id = s.slack_app_record_id
               JOIN slack_mobius_binding b ON b.tenant_id = a.tenant_id AND b.slack_bot_id = a.slack_bot_id
              WHERE s.tenant_id = ?1 AND a.slack_bot_id = ?2
                AND s.slack_channel_id = ?3
                AND IFNULL(s.thread_ts, '') = IFNULL(?4, '')
                AND s.connection_id = COALESCE(?5, b.connection_id)
              ORDER BY s.updated_at DESC LIMIT 1`,
            [input.tenantId, input.botId, input.channelId, input.threadTs, connectionId ?? null],
            signal,
        );
        if (row === null) {
            return null;
        }
        const conversation = v.parse(conversationRowSchema, row);
        return {
            id: conversation.id,
            latestEventTs: conversation.latest_event_ts,
            conversationId: conversation.conversation_id,
        };
    };

    readonly queuePending = async (
        tenant: TenantContext,
        input: SlackConversationInput,
        conversationMappingId: number,
        timestamp: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `INSERT OR IGNORE INTO slack_pending_message
                (tenant_id, conversation_mapping_id, slack_event_id, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
            [input.tenantId, conversationMappingId, input.eventId, JSON.stringify(input), timestamp],
            signal,
        );
    };

    readonly saveMessageDelivery = async (
        tenant: TenantContext,
        input: {
            readonly clientMessageId: string;
            readonly replyThreadTs: string | null;
            readonly sender: string;
            readonly conversationMappingId: number;
            readonly tenantId: string;
            readonly timestamp: number;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `INSERT INTO slack_message_delivery
                (tenant_id, client_message_id, conversation_mapping_id,
                 reply_thread_ts, status_thread_ts,
                 trigger_sender_info, delivery_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'pending', ?6, ?6)`,
            [
                input.tenantId,
                input.clientMessageId,
                input.conversationMappingId,
                input.replyThreadTs,
                input.sender,
                input.timestamp,
            ],
            signal,
        );
    };

    readonly markProcessed = async (
        tenant: TenantContext,
        eventId: string,
        status: "failed" | "processed",
        timestamp: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `UPDATE processed_slack_event
                SET status = ?2, processed_at = ?3,
                    payload = CASE WHEN ?2 = 'processed' THEN '' ELSE payload END
              WHERE slack_event_id = ?1 AND tenant_id = ?4 AND (status != 'processed' OR ?2 = 'processed')`,
            [eventId, status, timestamp, tenant.tenantId],
            signal,
        );
    };

    readonly findBotInstallation = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<BotSlackInstallation | null> => {
        const row = await this.#first(
            tenant,
            `SELECT i.bot_token_encrypted, i.slack_app_record_id,
                    i.slack_bot_user_id, i.slack_team_id, i.slack_team_name,
                    i.status, i.tenant_id, a.slack_app_id
               FROM slack_app a
               JOIN slack_installation i ON i.slack_app_record_id = a.id
              WHERE a.tenant_id = ?1 AND a.slack_bot_id = ?2
                AND a.status = 'enabled' AND i.status = 'connected'
              ORDER BY i.updated_at DESC LIMIT 1`,
            [tenantId, botId],
            signal,
        );
        if (row === null) {
            return null;
        }
        const value = v.parse(v.object({ ...installationRowSchema.entries, slack_app_id: v.string() }), row);
        return {
            botToken: await this.#cipher.decrypt(value.bot_token_encrypted, signal),
            slackAppId: value.slack_app_id,
            tenantId: value.tenant_id,
        };
    };

    readonly configTokenExists = async (
        tenant: TenantContext,
        tenantId: string,
        humanId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const row = v.parse(
            countRowSchema,
            await this.#first(
                tenant,
                "SELECT COUNT(*) AS count FROM slack_user_config_token WHERE tenant_id = ?1 AND human_id = ?2",
                [tenantId, humanId],
                signal,
            ),
        );
        return row.count > 0;
    };

    readonly getConfigToken = async (
        tenant: TenantContext,
        tenantId: string,
        humanId: string,
        signal: AbortSignal,
    ): Promise<{
        readonly accessTokenEncrypted: string;
        readonly expiresAt: number;
        readonly refreshTokenEncrypted: string;
    } | null> => {
        const row = await this.#first(
            tenant,
            `SELECT access_token_encrypted, refresh_token_encrypted, expires_at
               FROM slack_user_config_token
              WHERE tenant_id = ?1 AND human_id = ?2`,
            [tenantId, humanId],
            signal,
        );
        if (row === null) {
            return null;
        }
        const value = v.parse(configTokenRowSchema, row);
        return {
            accessTokenEncrypted: value.access_token_encrypted,
            expiresAt: value.expires_at,
            refreshTokenEncrypted: value.refresh_token_encrypted,
        };
    };

    readonly upsertConfigToken = async (
        tenant: TenantContext,
        input: {
            readonly accessTokenEncrypted: string;
            readonly expiresAt: number;
            readonly humanId: string;
            readonly refreshTokenEncrypted: string;
            readonly tenantId: string;
            readonly timestamp: number;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `INSERT INTO slack_user_config_token
                (tenant_id, human_id, access_token_encrypted,
                 refresh_token_encrypted, expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(tenant_id, human_id) DO UPDATE SET
                 access_token_encrypted = excluded.access_token_encrypted,
                 refresh_token_encrypted = excluded.refresh_token_encrypted,
                 expires_at = excluded.expires_at,
                 updated_at = excluded.updated_at`,
            [
                input.tenantId,
                input.humanId,
                input.accessTokenEncrypted,
                input.refreshTokenEncrypted,
                input.expiresAt,
                input.timestamp,
            ],
            signal,
        );
    };

    readonly deleteConfigToken = async (
        tenant: TenantContext,
        tenantId: string,
        humanId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            "DELETE FROM slack_user_config_token WHERE tenant_id = ?1 AND human_id = ?2",
            [tenantId, humanId],
            signal,
        );
    };

    readonly claimMessageDelivery = async (
        tenant: TenantContext,
        tenantId: string,
        clientMessageId: string,
        signal: AbortSignal,
    ): Promise<SlackMessageReplyContext | null> => {
        const changed = await this.#run(
            tenant,
            `UPDATE slack_message_delivery
                SET delivery_status = 'delivering', updated_at = ?3
              WHERE tenant_id = ?1 AND client_message_id = ?2
                AND delivery_status = 'pending'`,
            [tenantId, clientMessageId, Date.now()],
            signal,
        );
        if (changed.meta.changes !== 1) {
            return null;
        }
        const row = v.parse(
            messageDeliveryRowSchema,
            await this.#first(
                tenant,
                `SELECT p.tenant_id, p.conversation_mapping_id, p.reply_thread_ts,
                        p.status_thread_ts, s.slack_channel_id,
                        i.bot_token_encrypted
                   FROM slack_message_delivery p
                   JOIN slack_conversation_mapping s ON s.id = p.conversation_mapping_id
                   JOIN slack_installation i
                     ON i.slack_app_record_id = s.slack_app_record_id
                    AND i.slack_team_id = s.slack_team_id
                  WHERE p.tenant_id = ?1 AND p.client_message_id = ?2`,
                [tenantId, clientMessageId],
                signal,
            ),
        );
        return {
            botToken: await this.#cipher.decrypt(row.bot_token_encrypted, signal),
            channelId: row.slack_channel_id,
            replyThreadTs: row.reply_thread_ts,
            conversationMappingId: row.conversation_mapping_id,
            statusThreadTs: row.status_thread_ts,
            tenantId: row.tenant_id,
        };
    };

    readonly completeMessageDelivery = async (
        tenant: TenantContext,
        tenantId: string,
        clientMessageId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `UPDATE slack_message_delivery
                SET delivery_status = 'completed', updated_at = ?3
              WHERE tenant_id = ?1 AND client_message_id = ?2`,
            [tenantId, clientMessageId, Date.now()],
            signal,
        );
    };

    readonly resumePendingMessages = async (
        tenant: TenantContext,
        tenantId: string,
        conversationMappingId: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            `UPDATE slack_conversation_mapping
                SET updated_at = ?3
              WHERE tenant_id = ?1 AND id = ?2`,
            [tenantId, conversationMappingId, Date.now()],
            signal,
        );
        const pending = await this.#first(
            tenant,
            `SELECT id, payload FROM slack_pending_message
              WHERE tenant_id = ?1 AND conversation_mapping_id = ?2
              ORDER BY created_at, id LIMIT 1`,
            [tenantId, conversationMappingId],
            signal,
        );
        const parsed = v.safeParse(
            v.object({ id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), payload: v.string() }),
            pending,
        );
        if (!parsed.success) {
            return;
        }
        await this.#run(
            tenant,
            "DELETE FROM slack_pending_message WHERE id = ?1 AND tenant_id = ?2",
            [parsed.output.id, tenantId],
            signal,
        );
        const message = v.parse(queueMessageSchema, {
            input: JSON.parse(parsed.output.payload),
            kind: "pending-conversation",
        });
        await this.#events.send(message, signal);
        signal.throwIfAborted();
    };

    readonly #installation = async (
        tenant: TenantContext,
        where: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ): Promise<v.InferOutput<typeof installationRowSchema> | null> => {
        const row = await this.#first(
            tenant,
            `SELECT tenant_id, slack_app_record_id, slack_team_id, slack_team_name,
                    slack_bot_user_id, bot_token_encrypted, status
               FROM slack_installation ${where}`,
            values,
            signal,
        );
        return row === null ? null : v.parse(installationRowSchema, row);
    };

    readonly #eventTarget = async (row: unknown, signal: AbortSignal): Promise<StoredSlackEventTarget | null> => {
        if (row === null) {
            return null;
        }
        const target = v.parse(eventTargetRowSchema, row);
        return {
            botId: target.slack_bot_id,
            botToken: await this.#cipher.decrypt(target.bot_token_encrypted, signal),
            botUserId: target.slack_bot_user_id,
            slackAppRecordId: target.id,
            slackTeamId: target.slack_team_id,
            tenantId: target.tenant_id,
        };
    };

    readonly #first = async (
        _tenant: TenantContext,
        query: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const result = await this.#database.resolve().first(query, values, signal);
        signal.throwIfAborted();
        return result;
    };

    readonly #run = async (
        _tenant: TenantContext,
        query: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ): Promise<{ readonly meta: { readonly changes: number } }> => {
        signal.throwIfAborted();
        const result = await this.#database.resolve().run(query, values, signal);
        signal.throwIfAborted();
        return result;
    };
}
