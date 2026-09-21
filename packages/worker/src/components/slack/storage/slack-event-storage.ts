import { and, asc, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import * as v from "valibot";
import type { Database } from "../../../schema/d1/database.ts";
import {
    processedSlackEvent,
    slackApp,
    slackChatBotBinding,
    slackConversationLease,
    slackConversationMapping,
    slackInstallation,
    slackMessageDelivery,
    slackPendingMessage,
    slackUserConfigToken,
} from "../../../schema/d1/index.ts";
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
            signal,
            async (database) =>
                await database
                    .select({ status: processedSlackEvent.status })
                    .from(processedSlackEvent)
                    .where(
                        and(eq(processedSlackEvent.tenantId, tenantId), eq(processedSlackEvent.slackEventId, eventId)),
                    )
                    .get(),
        );
        return row !== undefined && v.parse(v.object({ status: v.string() }), row).status !== "processed";
    };
    readonly releaseMessageDelivery = async (
        tenant: TenantContext,
        tenantId: string,
        clientMessageId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#run(
            tenant,
            signal,
            async (database) =>
                await database
                    .update(slackMessageDelivery)
                    .set({ deliveryStatus: "pending" })
                    .where(
                        and(
                            eq(slackMessageDelivery.tenantId, tenantId),
                            eq(slackMessageDelivery.clientMessageId, clientMessageId),
                            eq(slackMessageDelivery.deliveryStatus, "delivering"),
                        ),
                    )
                    .run(),
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
        await this.#batch(tenant, 2, signal, async (database) => {
            const conversationId = database
                .select({ id: slackConversationMapping.id })
                .from(slackConversationMapping)
                .where(
                    and(
                        eq(slackConversationMapping.tenantId, c.tenantId),
                        eq(slackConversationMapping.conversationId, input.conversationId),
                    ),
                );
            await database.batch([
                database
                    .insert(slackConversationMapping)
                    .values({
                        tenantId: c.tenantId,
                        slackAppRecordId: input.slackAppRecordId,
                        slackTeamId: input.slackTeamId,
                        slackChannelId: c.channelId,
                        channelType: c.channelId.startsWith("D") ? "im" : "channel",
                        threadTs: c.threadTs,
                        initiatorSlackUserId: c.sender.kind === "user" ? c.sender.slackUserId : c.sender.slackBotId,
                        conversationId: input.conversationId,
                        connectionId: input.connectionId,
                        latestEventTs: input.latestEventTs,
                        lastActiveAt: now,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .onConflictDoUpdate({
                        target: [
                            slackConversationMapping.tenantId,
                            slackConversationMapping.slackAppRecordId,
                            slackConversationMapping.connectionId,
                            slackConversationMapping.slackChannelId,
                            sql`ifnull(${slackConversationMapping.threadTs}, '')`,
                        ],
                        set: {
                            conversationId: input.conversationId,
                            latestEventTs: input.latestEventTs,
                            lastActiveAt: now,
                            updatedAt: now,
                        },
                    }),
                database.insert(slackMessageDelivery).values({
                    tenantId: c.tenantId,
                    clientMessageId: input.clientMessageId,
                    conversationMappingId: sql`(${conversationId})`,
                    replyThreadTs: c.threadTs,
                    statusThreadTs: c.threadTs,
                    triggerSenderInfo: JSON.stringify(c.sender),
                    createdAt: now,
                    updatedAt: now,
                }),
            ]);
        });
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
            signal,
            async (database) =>
                await database
                    .insert(slackConversationLease)
                    .values({ conversationKey: key, owner, expiresAt: now + 660_000 })
                    .onConflictDoUpdate({
                        target: slackConversationLease.conversationKey,
                        set: { owner, expiresAt: now + 660_000 },
                        setWhere: lte(slackConversationLease.expiresAt, now),
                    })
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .delete(slackConversationLease)
                    .where(
                        and(eq(slackConversationLease.conversationKey, key), eq(slackConversationLease.owner, owner)),
                    )
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .select({ payload: processedSlackEvent.payload })
                    .from(processedSlackEvent)
                    .where(
                        and(
                            eq(processedSlackEvent.slackEventId, eventId),
                            eq(processedSlackEvent.tenantId, tenantId),
                            ne(processedSlackEvent.payload, ""),
                        ),
                    )
                    .get(),
        );
        if (row === undefined) {
            return null;
        }
        return v.parse(
            slackEventCallbackPayloadSchema,
            JSON.parse(v.parse(v.object({ payload: v.string() }), row).payload),
        );
    };
    readonly #database: Database;
    readonly #cipher: SecretCipher;
    readonly #events: SlackQueue;

    constructor(cx: {
        readonly gateways: { readonly queue: SlackQueue };
        readonly storages: {
            readonly database: Database;
        };
        readonly utilities: { readonly secretEncryption: SecretCipher };
    }) {
        const { queue: events } = cx.gateways;
        const { database } = cx.storages;
        const { secretEncryption: cipher } = cx.utilities;
        this.#database = database;
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
            signal,
            async (database) =>
                await database
                    .select({ signing_secret_encrypted: slackApp.signingSecretEncrypted })
                    .from(slackApp)
                    .where(and(eq(slackApp.slackAppId, slackAppId), eq(slackApp.status, "enabled")))
                    .get(),
        );
        if (row === undefined) {
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
            signal,
            async (database) =>
                await database
                    .select({ tenant_id: slackApp.tenantId })
                    .from(slackApp)
                    .where(and(eq(slackApp.slackAppId, slackAppId), eq(slackApp.status, "enabled")))
                    .get(),
        );
        return row === undefined ? null : v.parse(v.object({ tenant_id: v.string() }), row).tenant_id;
    };

    readonly insertEvent = async (
        tenant: TenantContext,
        tenantId: string,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await this.#run(
            tenant,
            signal,
            async (database) =>
                await database
                    .insert(processedSlackEvent)
                    .values({
                        tenantId,
                        slackEventId: payload.event_id,
                        slackAppId: payload.api_app_id,
                        slackTeamId: payload.team_id,
                        payload: JSON.stringify(payload),
                        status: "pending",
                        createdAt: Date.now(),
                    })
                    .onConflictDoNothing()
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .select({
                        id: slackApp.id,
                        tenant_id: slackApp.tenantId,
                        slack_bot_id: slackApp.slackBotId,
                        app_name: slackApp.appName,
                        slack_app_id: slackApp.slackAppId,
                        slack_client_id: slackApp.slackClientId,
                        client_secret_encrypted: slackApp.clientSecretEncrypted,
                        oauth_redirect_uri: slackApp.oauthRedirectUri,
                        status: slackApp.status,
                    })
                    .from(slackApp)
                    .where(and(eq(slackApp.tenantId, tenantId), eq(slackApp.slackBotId, botId)))
                    .get(),
        );
        if (row === undefined) {
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
            signal,
            async (database) =>
                await database
                    .select({
                        id: slackApp.id,
                        tenant_id: slackApp.tenantId,
                        slack_bot_id: slackApp.slackBotId,
                        app_name: slackApp.appName,
                        slack_app_id: slackApp.slackAppId,
                        slack_client_id: slackApp.slackClientId,
                        client_secret_encrypted: slackApp.clientSecretEncrypted,
                        oauth_redirect_uri: slackApp.oauthRedirectUri,
                        status: slackApp.status,
                    })
                    .from(slackApp)
                    .where(
                        and(
                            eq(slackApp.tenantId, tenantId),
                            eq(slackApp.slackBotId, botId),
                            eq(slackApp.status, "enabled"),
                        ),
                    )
                    .get(),
        );
        if (row === undefined) {
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
            signal,
            async (database) =>
                await database
                    .insert(slackApp)
                    .values({
                        tenantId: input.tenantId,
                        slackBotId: input.botId,
                        slackAppId: input.slackAppId,
                        slackClientId: input.clientId,
                        clientSecretEncrypted: input.clientSecretEncrypted,
                        signingSecretEncrypted: input.signingSecretEncrypted,
                        oauthRedirectUri: input.oauthRedirectUri,
                        appName: input.appName,
                        status: "enabled",
                        createdAt: input.timestamp,
                        updatedAt: input.timestamp,
                    })
                    .onConflictDoUpdate({
                        target: [slackApp.tenantId, slackApp.slackBotId],
                        set: {
                            slackAppId: input.slackAppId,
                            slackClientId: input.clientId,
                            clientSecretEncrypted: input.clientSecretEncrypted,
                            signingSecretEncrypted: input.signingSecretEncrypted,
                            oauthRedirectUri: input.oauthRedirectUri,
                            appName: input.appName,
                            status: "enabled",
                            updatedAt: input.timestamp,
                        },
                    })
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(slackApp)
                    .set({ status: "disabled", updatedAt: Date.now() })
                    .where(and(eq(slackApp.tenantId, tenantId), eq(slackApp.slackBotId, botId)))
                    .run(),
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
            signal,
            async (database) =>
                await this.#installationQuery(database)
                    .where(
                        and(
                            eq(slackInstallation.slackTeamId, slackTeamId),
                            eq(slackInstallation.slackAppRecordId, slackAppRecordId),
                        ),
                    )
                    .get(),
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
            signal,
            async (database) =>
                await this.#installationQuery(database)
                    .where(
                        and(
                            eq(slackInstallation.tenantId, tenantId),
                            eq(slackInstallation.slackAppRecordId, slackAppRecordId),
                        ),
                    )
                    .orderBy(desc(slackInstallation.updatedAt))
                    .get(),
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
            signal,
            async (database) =>
                await database
                    .insert(slackInstallation)
                    .values({
                        tenantId: input.tenantId,
                        slackAppRecordId: input.slackAppRecordId,
                        slackTeamId: input.slackTeamId,
                        slackTeamName: input.slackTeamName,
                        slackBotUserId: input.slackBotUserId,
                        botTokenEncrypted: input.botTokenEncrypted,
                        status: "connected",
                        installedAt: input.installedAt,
                        updatedAt: input.installedAt,
                    })
                    .onConflictDoUpdate({
                        target: [slackInstallation.slackAppRecordId, slackInstallation.slackTeamId],
                        set: {
                            tenantId: input.tenantId,
                            slackTeamName: input.slackTeamName,
                            slackBotUserId: input.slackBotUserId,
                            botTokenEncrypted: input.botTokenEncrypted,
                            status: "connected",
                            installedAt: input.installedAt,
                            updatedAt: input.installedAt,
                        },
                    })
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(slackInstallation)
                    .set({ status: "uninstalled", updatedAt: Date.now() })
                    .where(
                        and(
                            eq(slackInstallation.tenantId, tenantId),
                            eq(slackInstallation.slackAppRecordId, slackAppRecordId),
                        ),
                    )
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(slackInstallation)
                    .set({ status, updatedAt: Date.now() })
                    .where(
                        eq(
                            slackInstallation.slackAppRecordId,
                            database
                                .select({ id: slackApp.id })
                                .from(slackApp)
                                .where(eq(slackApp.slackAppId, slackAppId)),
                        ),
                    )
                    .run(),
        );
    };

    readonly findTargetForPayload = async (
        tenant: TenantContext,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<StoredSlackEventTarget | null> => {
        const row = await this.#first(
            tenant,
            signal,
            async (database) =>
                await this.#eventTargetQuery(database)
                    .where(
                        and(
                            eq(slackApp.slackAppId, payload.api_app_id),
                            eq(slackInstallation.slackTeamId, payload.team_id),
                            eq(slackApp.status, "enabled"),
                            eq(slackInstallation.status, "connected"),
                        ),
                    )
                    .get(),
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
            signal,
            async (database) =>
                await this.#eventTargetQuery(database)
                    .where(
                        and(
                            eq(slackApp.tenantId, tenantId),
                            eq(slackApp.slackBotId, botId),
                            eq(slackApp.status, "enabled"),
                            eq(slackInstallation.status, "connected"),
                        ),
                    )
                    .orderBy(desc(slackInstallation.updatedAt))
                    .get(),
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
            signal,
            async (database) =>
                await database
                    .select({ value: slackApp.slackBotId })
                    .from(slackApp)
                    .where(
                        and(
                            eq(slackApp.tenantId, tenantId),
                            eq(slackApp.slackAppId, slackAppId),
                            eq(slackApp.status, "enabled"),
                        ),
                    )
                    .get(),
        );
        return row === undefined ? null : v.parse(stringRowSchema, row).value;
    };

    readonly findConversation = async (
        tenant: TenantContext,
        input: SlackConversationKey,
        signal: AbortSignal,
        connectionId?: string,
    ): Promise<StoredSlackConversation | null> => {
        const row = await this.#first(
            tenant,
            signal,
            async (database) =>
                await database
                    .select({
                        id: slackConversationMapping.id,
                        conversation_id: slackConversationMapping.conversationId,
                        latest_event_ts: slackConversationMapping.latestEventTs,
                    })
                    .from(slackConversationMapping)
                    .innerJoin(slackApp, eq(slackApp.id, slackConversationMapping.slackAppRecordId))
                    .innerJoin(
                        slackChatBotBinding,
                        and(
                            eq(slackChatBotBinding.tenantId, slackApp.tenantId),
                            eq(slackChatBotBinding.slackBotId, slackApp.slackBotId),
                        ),
                    )
                    .where(
                        and(
                            eq(slackConversationMapping.tenantId, input.tenantId),
                            eq(slackApp.slackBotId, input.botId),
                            eq(slackConversationMapping.slackChannelId, input.channelId),
                            input.threadTs === null
                                ? isNull(slackConversationMapping.threadTs)
                                : eq(slackConversationMapping.threadTs, input.threadTs),
                            eq(slackConversationMapping.connectionId, connectionId ?? slackChatBotBinding.connectionId),
                        ),
                    )
                    .orderBy(desc(slackConversationMapping.updatedAt))
                    .get(),
        );
        if (row === undefined) {
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
            signal,
            async (database) =>
                await database
                    .insert(slackPendingMessage)
                    .values({
                        tenantId: input.tenantId,
                        conversationMappingId,
                        slackEventId: input.eventId,
                        payload: JSON.stringify(input),
                        createdAt: timestamp,
                    })
                    .onConflictDoNothing()
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .insert(slackMessageDelivery)
                    .values({
                        tenantId: input.tenantId,
                        clientMessageId: input.clientMessageId,
                        conversationMappingId: input.conversationMappingId,
                        replyThreadTs: input.replyThreadTs,
                        statusThreadTs: input.replyThreadTs,
                        triggerSenderInfo: input.sender,
                        deliveryStatus: "pending",
                        createdAt: input.timestamp,
                        updatedAt: input.timestamp,
                    })
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(processedSlackEvent)
                    .set({
                        status,
                        processedAt: timestamp,
                        payload: status === "processed" ? "" : processedSlackEvent.payload,
                    })
                    .where(
                        and(
                            eq(processedSlackEvent.slackEventId, eventId),
                            eq(processedSlackEvent.tenantId, tenant.tenantId),
                            status === "processed" ? undefined : ne(processedSlackEvent.status, "processed"),
                        ),
                    )
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .select({
                        bot_token_encrypted: slackInstallation.botTokenEncrypted,
                        slack_app_record_id: slackInstallation.slackAppRecordId,
                        slack_bot_user_id: slackInstallation.slackBotUserId,
                        slack_team_id: slackInstallation.slackTeamId,
                        slack_team_name: slackInstallation.slackTeamName,
                        status: slackInstallation.status,
                        tenant_id: slackInstallation.tenantId,
                        slack_app_id: slackApp.slackAppId,
                    })
                    .from(slackApp)
                    .innerJoin(slackInstallation, eq(slackInstallation.slackAppRecordId, slackApp.id))
                    .where(
                        and(
                            eq(slackApp.tenantId, tenantId),
                            eq(slackApp.slackBotId, botId),
                            eq(slackApp.status, "enabled"),
                            eq(slackInstallation.status, "connected"),
                        ),
                    )
                    .orderBy(desc(slackInstallation.updatedAt))
                    .get(),
        );
        if (row === undefined) {
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
        const row = await this.#first(
            tenant,
            signal,
            async (database) =>
                await database
                    .select({ id: slackUserConfigToken.id })
                    .from(slackUserConfigToken)
                    .where(and(eq(slackUserConfigToken.tenantId, tenantId), eq(slackUserConfigToken.humanId, humanId)))
                    .get(),
        );
        return row !== undefined;
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
            signal,
            async (database) =>
                await database
                    .select({
                        access_token_encrypted: slackUserConfigToken.accessTokenEncrypted,
                        refresh_token_encrypted: slackUserConfigToken.refreshTokenEncrypted,
                        expires_at: slackUserConfigToken.expiresAt,
                    })
                    .from(slackUserConfigToken)
                    .where(and(eq(slackUserConfigToken.tenantId, tenantId), eq(slackUserConfigToken.humanId, humanId)))
                    .get(),
        );
        if (row === undefined) {
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
            signal,
            async (database) =>
                await database
                    .insert(slackUserConfigToken)
                    .values({
                        tenantId: input.tenantId,
                        humanId: input.humanId,
                        accessTokenEncrypted: input.accessTokenEncrypted,
                        refreshTokenEncrypted: input.refreshTokenEncrypted,
                        expiresAt: input.expiresAt,
                        createdAt: input.timestamp,
                        updatedAt: input.timestamp,
                    })
                    .onConflictDoUpdate({
                        target: [slackUserConfigToken.tenantId, slackUserConfigToken.humanId],
                        set: {
                            accessTokenEncrypted: input.accessTokenEncrypted,
                            refreshTokenEncrypted: input.refreshTokenEncrypted,
                            expiresAt: input.expiresAt,
                            updatedAt: input.timestamp,
                        },
                    })
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .delete(slackUserConfigToken)
                    .where(and(eq(slackUserConfigToken.tenantId, tenantId), eq(slackUserConfigToken.humanId, humanId)))
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(slackMessageDelivery)
                    .set({ deliveryStatus: "delivering", updatedAt: Date.now() })
                    .where(
                        and(
                            eq(slackMessageDelivery.tenantId, tenantId),
                            eq(slackMessageDelivery.clientMessageId, clientMessageId),
                            eq(slackMessageDelivery.deliveryStatus, "pending"),
                        ),
                    )
                    .run(),
        );
        if (changed.meta.changes !== 1) {
            return null;
        }
        const row = v.parse(
            messageDeliveryRowSchema,
            await this.#first(
                tenant,
                signal,
                async (database) =>
                    await database
                        .select({
                            tenant_id: slackMessageDelivery.tenantId,
                            conversation_mapping_id: slackMessageDelivery.conversationMappingId,
                            reply_thread_ts: slackMessageDelivery.replyThreadTs,
                            status_thread_ts: slackMessageDelivery.statusThreadTs,
                            slack_channel_id: slackConversationMapping.slackChannelId,
                            bot_token_encrypted: slackInstallation.botTokenEncrypted,
                        })
                        .from(slackMessageDelivery)
                        .innerJoin(
                            slackConversationMapping,
                            eq(slackConversationMapping.id, slackMessageDelivery.conversationMappingId),
                        )
                        .innerJoin(
                            slackInstallation,
                            and(
                                eq(slackInstallation.slackAppRecordId, slackConversationMapping.slackAppRecordId),
                                eq(slackInstallation.slackTeamId, slackConversationMapping.slackTeamId),
                            ),
                        )
                        .where(
                            and(
                                eq(slackMessageDelivery.tenantId, tenantId),
                                eq(slackMessageDelivery.clientMessageId, clientMessageId),
                            ),
                        )
                        .get(),
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
            signal,
            async (database) =>
                await database
                    .update(slackMessageDelivery)
                    .set({ deliveryStatus: "completed", updatedAt: Date.now() })
                    .where(
                        and(
                            eq(slackMessageDelivery.tenantId, tenantId),
                            eq(slackMessageDelivery.clientMessageId, clientMessageId),
                        ),
                    )
                    .run(),
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
            signal,
            async (database) =>
                await database
                    .update(slackConversationMapping)
                    .set({ updatedAt: Date.now() })
                    .where(
                        and(
                            eq(slackConversationMapping.tenantId, tenantId),
                            eq(slackConversationMapping.id, conversationMappingId),
                        ),
                    )
                    .run(),
        );
        const pending = await this.#first(
            tenant,
            signal,
            async (database) =>
                await database
                    .select({ id: slackPendingMessage.id, payload: slackPendingMessage.payload })
                    .from(slackPendingMessage)
                    .where(
                        and(
                            eq(slackPendingMessage.tenantId, tenantId),
                            eq(slackPendingMessage.conversationMappingId, conversationMappingId),
                        ),
                    )
                    .orderBy(asc(slackPendingMessage.createdAt), asc(slackPendingMessage.id))
                    .get(),
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
            signal,
            async (database) =>
                await database
                    .delete(slackPendingMessage)
                    .where(
                        and(eq(slackPendingMessage.id, parsed.output.id), eq(slackPendingMessage.tenantId, tenantId)),
                    )
                    .run(),
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
        signal: AbortSignal,
        query: (database: Database) => Promise<unknown>,
    ): Promise<v.InferOutput<typeof installationRowSchema> | null> => {
        const row = await this.#first(tenant, signal, query);
        return row === undefined ? null : v.parse(installationRowSchema, row);
    };

    readonly #installationQuery = (database: Database) =>
        database
            .select({
                tenant_id: slackInstallation.tenantId,
                slack_app_record_id: slackInstallation.slackAppRecordId,
                slack_team_id: slackInstallation.slackTeamId,
                slack_team_name: slackInstallation.slackTeamName,
                slack_bot_user_id: slackInstallation.slackBotUserId,
                bot_token_encrypted: slackInstallation.botTokenEncrypted,
                status: slackInstallation.status,
            })
            .from(slackInstallation)
            .$dynamic();

    readonly #eventTargetQuery = (database: Database) =>
        database
            .select({
                id: slackApp.id,
                tenant_id: slackApp.tenantId,
                slack_bot_id: slackApp.slackBotId,
                slack_team_id: slackInstallation.slackTeamId,
                slack_bot_user_id: slackInstallation.slackBotUserId,
                bot_token_encrypted: slackInstallation.botTokenEncrypted,
            })
            .from(slackApp)
            .innerJoin(slackInstallation, eq(slackInstallation.slackAppRecordId, slackApp.id))
            .$dynamic();

    readonly #eventTarget = async (row: unknown, signal: AbortSignal): Promise<StoredSlackEventTarget | null> => {
        if (row === undefined) {
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
        signal: AbortSignal,
        query: (database: Database) => Promise<unknown>,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const result = await query(this.#database);
        signal.throwIfAborted();
        return result;
    };

    readonly #run = async (
        _tenant: TenantContext,
        signal: AbortSignal,
        query: (database: Database) => Promise<D1Result>,
    ): Promise<{ readonly meta: { readonly changes: number } }> => {
        signal.throwIfAborted();
        const result = await query(this.#database);
        signal.throwIfAborted();
        return result;
    };

    readonly #batch = async (
        _tenant: TenantContext,
        _queryCount: number,
        signal: AbortSignal,
        query: (database: Database) => Promise<void>,
    ): Promise<void> => {
        signal.throwIfAborted();
        await query(this.#database);
        signal.throwIfAborted();
    };
}
