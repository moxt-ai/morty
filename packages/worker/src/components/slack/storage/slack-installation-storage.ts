import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import type { Database } from "../../../schema/project-do/database.ts";
import { slackApp, slackInstallation, slackUserConfigToken } from "../../../schema/project-do/index.ts";
import type {
    BotSlackInstallation,
    ManagedSlackApp,
    ManagedSlackInstallation,
    SlackAppConfiguration,
    SlackInstallationRecord,
} from "../entity/installation";
import type { TenantContext } from "../entity/tenant-context";
import type { SecretCipher } from "../infra/index";

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

export class SlackInstallationStorage {
    readonly #database: Database;
    readonly #cipher: SecretCipher;
    constructor(database: Database, cipher: SecretCipher) {
        this.#database = database;
        this.#cipher = cipher;
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
}
