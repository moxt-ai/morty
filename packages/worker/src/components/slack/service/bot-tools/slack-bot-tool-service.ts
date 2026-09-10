import type { TenantContext } from "../identity/tenant-context";
export interface BotSlackInstallation {
    readonly botToken: string;
    readonly slackAppId: string;
    readonly tenantId: string;
}

export interface SlackMessage {
    readonly botId: string | null;
    readonly files: readonly SlackMessageFile[];
    readonly text: string;
    readonly threadTs: string | null;
    readonly ts: string;
    readonly userId: string | null;
}

export interface SlackMessageFile {
    readonly id: string;
    readonly mimetype: string | null;
    readonly name: string | null;
    readonly size: number | null;
    readonly urlPrivate: string | null;
}

import type { ErrorToResponse } from "../../infra/error-to-response";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { ExternalIdentityService } from "../identity/external-identity-service";

class SlackBotToolError extends Error implements ErrorToResponse {
    readonly toResponse = (): Response =>
        Response.json({ error: { code: this.code, message: this.message } }, { status: 400 });
    readonly code: "SLACK_INSTALLATION_NOT_FOUND";

    constructor(code: "SLACK_INSTALLATION_NOT_FOUND", message: string) {
        super(message);
        this.name = "SlackBotToolError";
        this.code = code;
    }
}

export class SlackBotToolService {
    readonly #identities: ExternalIdentityService;
    readonly #installations: SlackEventStorage;
    readonly #slack: SlackWebApi;
    constructor(cx: {
        readonly services: { readonly identities: ExternalIdentityService };
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly slackWebApi: SlackWebApi };
    }) {
        const { identities } = cx.services;
        const { slackEventStorage: installations } = cx.storages;
        const { slackWebApi: slack } = cx.gateways;
        this.#identities = identities;
        this.#installations = installations;
        this.#slack = slack;
    }

    readonly sendMessage = async (
        tenant: TenantContext,
        actor: BotActor,
        input: {
            readonly channelId: string;
            readonly text: string;
            readonly threadTs: string | null;
        },
        signal: AbortSignal,
    ): Promise<{ readonly channelId: string; readonly ts: string }> => {
        const installation = await this.#installation(tenant, actor, signal);
        return await this.#slack.sendMessage(
            installation.botToken,
            input.channelId,
            input.text,
            input.threadTs,
            signal,
        );
    };

    readonly sendDirectMessageToSlackUser = async (
        tenant: TenantContext,
        actor: BotActor,
        slackUserId: string,
        text: string,
        signal: AbortSignal,
    ): Promise<{ readonly channelId: string; readonly ts: string }> => {
        const installation = await this.#installation(tenant, actor, signal);
        return await this.#slack.sendDirectMessage(installation.botToken, slackUserId, text, signal);
    };

    readonly listChannels = async (
        tenant: TenantContext,
        actor: BotActor,
        signal: AbortSignal,
    ): Promise<readonly { readonly id: string; readonly name: string }[]> => {
        const installation = await this.#installation(tenant, actor, signal);
        return await this.#slack.listChannels(installation.botToken, signal);
    };

    readonly getChannelMessages = async (
        tenant: TenantContext,
        actor: BotActor,
        channelId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> => {
        const installation = await this.#installation(tenant, actor, signal);
        return await this.#slack.getChannelMessages(installation.botToken, channelId, limit, signal);
    };

    readonly getThreadMessages = async (
        tenant: TenantContext,
        actor: BotActor,
        channelId: string,
        threadTs: string,
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> => {
        const installation = await this.#installation(tenant, actor, signal);
        return await this.#slack.getThreadMessages(installation.botToken, channelId, threadTs, signal);
    };

    readonly addReaction = async (
        tenant: TenantContext,
        actor: BotActor,
        channelId: string,
        messageTs: string,
        name: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const installation = await this.#installation(tenant, actor, signal);
        await this.#slack.addReaction(installation.botToken, channelId, messageTs, name, signal);
    };

    readonly removeReaction = async (
        tenant: TenantContext,
        actor: BotActor,
        channelId: string,
        messageTs: string,
        name: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const installation = await this.#installation(tenant, actor, signal);
        await this.#slack.removeReaction(installation.botToken, channelId, messageTs, name, signal);
    };

    readonly #installation = async (
        tenant: TenantContext,
        actor: BotActor,
        signal: AbortSignal,
    ): Promise<BotSlackInstallation> => {
        await this.#identities.authorizeBot(actor.tenantId, actor.botId, signal);
        const installation = await this.#installations.findBotInstallation(tenant, actor.tenantId, actor.botId, signal);
        if (installation === null) {
            throw new SlackBotToolError(
                "SLACK_INSTALLATION_NOT_FOUND",
                "Bot does not have an active Slack installation",
            );
        }
        return installation;
    };
}

export interface BotActor {
    readonly botId: string;
    readonly tenantId: string;
}

import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
