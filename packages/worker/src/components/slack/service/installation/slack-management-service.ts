import type { HumanPrincipal } from "../identity/identity-service";
import type { SlackTokenService } from "../identity/slack-token-service";
import { type TenantContext, tenantContext } from "../identity/tenant-context";
import type { ChatBotBindingService } from "./chat-bot-binding-service";
import type { SlackInstallationService } from "./slack-installation-service";

export type SlackConnectionStatus =
    | { readonly kind: "not-configured" }
    | {
          readonly appName: string;
          readonly kind: "not-installed";
          readonly slackAppId: string;
      }
    | {
          readonly appName: string;
          readonly kind: "connected";
          readonly slackAppId: string;
          readonly slackTeamId: string;
          readonly slackTeamName: string | null;
      }
    | {
          readonly appName: string;
          readonly kind: "disconnected";
          readonly reason: "error" | "token-revoked" | "uninstalled";
          readonly slackAppId: string;
      };

export interface SlackManifest {
    readonly display_information: {
        readonly description: string;
        readonly name: string;
    };
    readonly features: {
        readonly agent_view: { readonly agent_description: string };
        readonly app_home: {
            readonly home_tab_enabled: false;
            readonly messages_tab_enabled: true;
            readonly messages_tab_read_only_enabled: false;
        };
        readonly bot_user: {
            readonly always_online: true;
            readonly display_name: string;
        };
    };
    readonly oauth_config: {
        readonly redirect_urls: readonly string[];
        readonly scopes: { readonly bot: readonly string[] };
    };
    readonly settings: {
        readonly event_subscriptions: {
            readonly bot_events: readonly string[];
            readonly request_url: string;
        };
        readonly org_deploy_enabled: false;
        readonly socket_mode_enabled: false;
        readonly token_rotation_enabled: false;
    };
}

import type { ErrorToResponse } from "../../infra/util/error-to-response";
import type { SlackEventStorage } from "../../storage/slack-event-storage";

class SlackManagementError extends Error implements ErrorToResponse {
    readonly toResponse = (): Response =>
        Response.json({ error: { code: this.code, message: this.message } }, { status: 400 });
    readonly code: "APP_NOT_CONFIGURED" | "CONFIG_TOKEN_NOT_CONFIGURED" | "INVALID_APP_NAME";

    constructor(code: "APP_NOT_CONFIGURED" | "CONFIG_TOKEN_NOT_CONFIGURED" | "INVALID_APP_NAME", message: string) {
        super(message);
        this.name = "SlackManagementError";
        this.code = code;
    }
}

export class SlackManagementService {
    readonly #apps: SlackEventStorage;
    readonly #configTokens: SlackEventStorage;
    readonly #installations: SlackEventStorage;
    readonly #manifestApi: SlackWebApi;
    readonly #nowEpochMilliseconds: () => number;
    readonly #publicBaseUrl: string;
    readonly #projectId: string;
    readonly #secrets: SecretCipher;
    readonly #bindings: ChatBotBindingService;
    readonly #installationService: SlackInstallationService;
    readonly #tokens: SlackTokenService;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly services: {
            readonly installations: SlackInstallationService;
            readonly chatBotBindings: ChatBotBindingService;
            readonly slackTokens: SlackTokenService;
        };
        readonly gateways: {
            readonly slackWebApi: SlackWebApi;
            readonly secretEncryption: SecretCipher;
            readonly nowEpochMilliseconds: () => number;
        };
        readonly config: { readonly publicBaseUrl: string; readonly projectId: string };
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { installations, chatBotBindings, slackTokens } = cx.services;
        const { slackWebApi: manifestApi, secretEncryption: secrets, nowEpochMilliseconds } = cx.gateways;
        const { publicBaseUrl } = cx.config;
        this.#bindings = chatBotBindings;
        this.#installationService = installations;
        this.#tokens = slackTokens;
        this.#apps = storage;
        this.#configTokens = storage;
        this.#installations = storage;
        this.#manifestApi = manifestApi;
        this.#nowEpochMilliseconds = nowEpochMilliseconds;
        this.#publicBaseUrl = publicBaseUrl;
        this.#projectId = cx.config.projectId;
        this.#secrets = secrets;
    }

    readonly status = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        botId: string,
        signal: AbortSignal,
    ): Promise<SlackConnectionStatus> => {
        const app = await this.#apps.findApp(tenant, principal.tenantId, botId, signal);
        if (app === null || app.status === "disabled") {
            return { kind: "not-configured" };
        }
        const installation = await this.#installations.findLatestInstallation(
            tenant,
            principal.tenantId,
            app.id,
            signal,
        );
        if (installation === null) {
            return {
                appName: app.appName,
                kind: "not-installed",
                slackAppId: app.slackAppId,
            };
        }
        if (installation.status === "connected") {
            return {
                appName: app.appName,
                kind: "connected",
                slackAppId: app.slackAppId,
                slackTeamId: installation.slackTeamId,
                slackTeamName: installation.slackTeamName,
            };
        }
        return {
            appName: app.appName,
            kind: "disconnected",
            reason: installation.status === "token_revoked" ? "token-revoked" : installation.status,
            slackAppId: app.slackAppId,
        };
    };

    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) =>
        await this.#bindings.listBots(tenant, signal);

    readonly listOwnedBots = async (tenant: TenantContext, signal: AbortSignal) =>
        await this.#bindings.listOwnedBots(tenant, signal);

    readonly authorizationUrl = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        botId: string,
        signal: AbortSignal,
    ) => ({
        url: await this.#installationService.createAuthorizationUrl(
            tenant,
            { botId, humanId: principal.humanId, tenantId: principal.tenantId },
            signal,
        ),
    });

    readonly completeAuthorization = async (code: string, state: string, signal: AbortSignal): Promise<void> => {
        const verified = await this.#tokens.readOAuthState(state, signal);
        await this.#installationService.completeAuthorization(tenantContext(verified.tenantId), code, verified, signal);
    };

    readonly registerManualAppAndAuthorize = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        input: Parameters<SlackManagementService["registerManualApp"]>[2],
        signal: AbortSignal,
    ) => {
        await this.registerManualApp(tenant, principal, input, signal);
        const { url } = await this.authorizationUrl(tenant, principal, input.slackBotId, signal);
        return { oauthAuthorizeUrl: url };
    };

    readonly createAppAndAuthorize = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        input: Parameters<SlackManagementService["createApp"]>[2],
        signal: AbortSignal,
    ) => {
        const created = await this.createApp(tenant, principal, input, signal);
        const { url: oauthAuthorizeUrl } = await this.authorizationUrl(tenant, principal, input.slackBotId, signal);
        return { ...created, oauthAuthorizeUrl };
    };

    readonly registerManualApp = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        input: {
            readonly slackBotId: string;
            readonly clientId: string;
            readonly clientSecret: string;
            readonly name: string;
            readonly signingSecret: string;
            readonly slackAppId: string;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        validateAppName(input.name);
        await this.#apps.registerApp(
            tenant,
            {
                botId: input.slackBotId,
                appName: input.name,
                clientId: input.clientId,
                clientSecretEncrypted: await this.#secrets.encrypt(input.clientSecret, signal),
                oauthRedirectUri: `${this.#publicBaseUrl}/mobius-slack/api/slack/oauth/callback?projectId=${encodeURIComponent(this.#projectId)}`,
                signingSecretEncrypted: await this.#secrets.encrypt(input.signingSecret, signal),
                slackAppId: input.slackAppId,
                tenantId: principal.tenantId,
                timestamp: this.#nowEpochMilliseconds(),
            },
            signal,
        );
    };

    readonly createApp = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        input: {
            readonly slackBotId: string;
            readonly name: string;
        },
        signal: AbortSignal,
    ): Promise<{ readonly slackAppId: string }> => {
        const manifest = this.manifest(input.name);
        const token = await this.#usableConfigToken(tenant, principal, signal);
        const created = await this.#manifestApi.createManifestApp(token, manifest, signal);
        await this.registerManualApp(
            tenant,
            principal,
            {
                ...input,
                clientId: created.clientId,
                clientSecret: created.clientSecret,
                signingSecret: created.signingSecret,
                slackAppId: created.slackAppId,
            },
            signal,
        );
        return { slackAppId: created.slackAppId };
    };

    readonly disconnect = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        botId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const app = await this.#apps.findApp(tenant, principal.tenantId, botId, signal);
        if (app === null) {
            throw new SlackManagementError("APP_NOT_CONFIGURED", "Slack app is not configured");
        }
        await this.#installations.uninstallInstallation(tenant, principal.tenantId, app.id, signal);
        await this.#apps.disableApp(tenant, principal.tenantId, botId, signal);
    };

    readonly configTokenStatus = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        signal: AbortSignal,
    ): Promise<{ readonly configured: boolean }> => ({
        configured: await this.#configTokens.configTokenExists(tenant, principal.tenantId, principal.humanId, signal),
    });

    readonly saveConfigToken = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        refreshToken: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const rotated = await this.#manifestApi.rotateConfigToken(refreshToken, signal);
        await this.#configTokens.upsertConfigToken(
            tenant,
            {
                accessTokenEncrypted: await this.#secrets.encrypt(rotated.accessToken, signal),
                expiresAt: rotated.expiresAt,
                humanId: principal.humanId,
                refreshTokenEncrypted: await this.#secrets.encrypt(rotated.refreshToken, signal),
                tenantId: principal.tenantId,
                timestamp: this.#nowEpochMilliseconds(),
            },
            signal,
        );
    };

    readonly deleteConfigToken = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#configTokens.deleteConfigToken(tenant, principal.tenantId, principal.humanId, signal);
    };

    readonly manifest = (name: string): SlackManifest => {
        validateAppName(name);
        const eventsUrl = `${this.#publicBaseUrl}/mobius-slack/api/slack/events?projectId=${encodeURIComponent(this.#projectId)}`;
        return {
            display_information: {
                description: "A Mobius bot in Slack",
                name,
            },
            features: {
                agent_view: {
                    agent_description: "Work with this Mobius bot",
                },
                app_home: {
                    home_tab_enabled: false,
                    messages_tab_enabled: true,
                    messages_tab_read_only_enabled: false,
                },
                bot_user: { always_online: true, display_name: name },
            },
            oauth_config: {
                redirect_urls: [
                    `${this.#publicBaseUrl}/mobius-slack/api/slack/oauth/callback?projectId=${encodeURIComponent(this.#projectId)}`,
                ],
                scopes: {
                    bot: [
                        "app_mentions:read",
                        "assistant:write",
                        "channels:history",
                        "channels:read",
                        "chat:write",
                        "chat:write.customize",
                        "commands",
                        "files:read",
                        "files:write",
                        "groups:history",
                        "groups:read",
                        "groups:write",
                        "im:history",
                        "im:read",
                        "im:write",
                        "mpim:history",
                        "mpim:read",
                        "mpim:write",
                        "pins:read",
                        "reactions:read",
                        "reactions:write",
                        "users:read",
                        "users:read.email",
                    ],
                },
            },
            settings: {
                event_subscriptions: {
                    bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"],
                    request_url: eventsUrl,
                },
                org_deploy_enabled: false,
                socket_mode_enabled: false,
                token_rotation_enabled: false,
            },
        };
    };

    readonly #usableConfigToken = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        signal: AbortSignal,
    ): Promise<string> => {
        const stored = await this.#configTokens.getConfigToken(tenant, principal.tenantId, principal.humanId, signal);
        if (stored === null) {
            throw new SlackManagementError(
                "CONFIG_TOKEN_NOT_CONFIGURED",
                "Slack configuration token is not configured",
            );
        }
        if (stored.expiresAt > this.#nowEpochMilliseconds() + 300_000) {
            return await this.#secrets.decrypt(stored.accessTokenEncrypted, signal);
        }
        const rotated = await this.#manifestApi.rotateConfigToken(
            await this.#secrets.decrypt(stored.refreshTokenEncrypted, signal),
            signal,
        );
        await this.#configTokens.upsertConfigToken(
            tenant,
            {
                accessTokenEncrypted: await this.#secrets.encrypt(rotated.accessToken, signal),
                expiresAt: rotated.expiresAt,
                humanId: principal.humanId,
                refreshTokenEncrypted: await this.#secrets.encrypt(rotated.refreshToken, signal),
                tenantId: principal.tenantId,
                timestamp: this.#nowEpochMilliseconds(),
            },
            signal,
        );
        return rotated.accessToken;
    };
}

function validateAppName(name: string): void {
    if (!/^[A-Za-z0-9 ._-]{1,35}$/u.test(name)) {
        throw new SlackManagementError(
            "INVALID_APP_NAME",
            "Slack app name must be 1-35 Latin letters, numbers, spaces, dots, underscores, or hyphens",
        );
    }
}

import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
import type { SecretCipher } from "../../infra/util/secret-cipher";
