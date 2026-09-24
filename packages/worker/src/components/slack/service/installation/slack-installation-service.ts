import type { HttpError } from "../../../../infra/http-error.ts";
import type { SlackTokenService } from "../identity/slack-token-service";
import type { TenantContext } from "../identity/tenant-context";

const AI_BOT_APP_SCOPES = [
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
].join(",");

import type { SlackAppConfiguration } from "../../entity/installation";

export type { SlackAppConfiguration } from "../../entity/installation";

export interface SlackOAuthInstallation {
    readonly accessToken: string;
    readonly authedUserId: string | null;
    readonly botUserId: string;
    readonly teamId: string;
    readonly teamName: string | null;
}

import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { ExternalIdentityService } from "../identity/external-identity-service";

class SlackInstallationError extends Error implements HttpError {
    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.code === "SLACK_WORKSPACE_ALREADY_LINKED" ? 409 : 400,
    });
    readonly code: "SLACK_APP_NOT_CONFIGURED" | "SLACK_WORKSPACE_ALREADY_LINKED";

    constructor(code: "SLACK_APP_NOT_CONFIGURED" | "SLACK_WORKSPACE_ALREADY_LINKED", message: string) {
        super(message);
        this.name = "SlackInstallationError";
        this.code = code;
    }
}

export class SlackInstallationService {
    readonly #apps: SlackEventStorage;
    readonly #identities: ExternalIdentityService;
    readonly #installations: SlackEventStorage;
    readonly #oauth: SlackWebApi;
    readonly #secrets: SecretCipher;
    readonly #tokens: SlackTokenService;
    readonly #nowEpochMilliseconds: () => number;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly services: { readonly identities: ExternalIdentityService; readonly slackTokens: SlackTokenService };
        readonly gateways: { readonly slackWebApi: SlackWebApi };
        readonly utilities: {
            readonly secretEncryption: SecretCipher;
            readonly nowEpochMilliseconds: () => number;
        };
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { identities, slackTokens: tokens } = cx.services;
        const { slackWebApi: oauth } = cx.gateways;
        const { secretEncryption: secrets, nowEpochMilliseconds } = cx.utilities;
        this.#apps = storage;
        this.#identities = identities;
        this.#installations = storage;
        this.#oauth = oauth;
        this.#secrets = secrets;
        this.#tokens = tokens;
        this.#nowEpochMilliseconds = nowEpochMilliseconds;
    }

    readonly createAuthorizationUrl = async (
        tenant: TenantContext,
        input: {
            readonly botId: string;
            readonly humanId: string;
            readonly tenantId: string;
        },
        signal: AbortSignal,
    ): Promise<string> => {
        await this.#identities.authorizeHumanBot(input.tenantId, input.humanId, input.botId, signal);
        const app = await this.#requireApp(tenant, input.tenantId, input.botId, signal);
        const state = await this.#tokens.issueOAuthState(input, signal);
        const parameters = new URLSearchParams({
            client_id: app.clientId,
            redirect_uri: app.oauthRedirectUri,
            scope: AI_BOT_APP_SCOPES,
            state,
        });
        return `https://slack.com/oauth/v2/authorize?${parameters.toString()}`;
    };

    readonly completeAuthorization = async (
        tenant: TenantContext,
        code: string,
        state: Awaited<ReturnType<SlackTokenService["readOAuthState"]>>,
        signal: AbortSignal,
    ): Promise<{ readonly tenantId: string }> => {
        await this.#identities.authorizeHumanBot(state.tenantId, state.humanId, state.botId, signal);
        const app = await this.#requireApp(tenant, state.tenantId, state.botId, signal);
        const clientSecret = await this.#secrets.decrypt(app.clientSecretEncrypted, signal);
        const installation = await this.#oauth.exchangeCode(
            {
                clientId: app.clientId,
                clientSecret,
                code,
                redirectUri: app.oauthRedirectUri,
            },
            signal,
        );
        const existing = await this.#installations.findInstallationByTeamAndApp(
            tenant,
            installation.teamId,
            app.id,
            signal,
        );
        if (existing !== null && existing.tenantId !== state.tenantId) {
            throw new SlackInstallationError(
                "SLACK_WORKSPACE_ALREADY_LINKED",
                "Slack workspace is already linked to another tenant",
            );
        }

        await this.#installations.upsertInstallation(
            tenant,
            {
                botTokenEncrypted: await this.#secrets.encrypt(installation.accessToken, signal),
                installedAt: this.#nowEpochMilliseconds(),
                slackAppRecordId: app.id,
                slackBotUserId: installation.botUserId,
                slackTeamId: installation.teamId,
                slackTeamName: installation.teamName,
                tenantId: state.tenantId,
            },
            signal,
        );

        if (installation.authedUserId !== null) {
            await this.#oauth.sendDirectMessage(
                installation.accessToken,
                installation.authedUserId,
                "Slack is now connected to your Mobius bot.",
                signal,
            );
        }
        return { tenantId: state.tenantId };
    };

    readonly #requireApp = async (
        tenant: TenantContext,
        tenantId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<SlackAppConfiguration> => {
        const app = await this.#apps.findEnabledAppConfiguration(tenant, tenantId, botId, signal);
        if (app === null) {
            throw new SlackInstallationError("SLACK_APP_NOT_CONFIGURED", "Slack app is not configured for this bot");
        }
        return app;
    };
}

import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
import type { SecretCipher } from "../../infra/util/secret-cipher";
