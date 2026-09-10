import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { SlackEventCallbackPayload } from "../events/events";
import type { TenantContext } from "../identity/tenant-context";
import type { SlackConversationKey, SlackEventTargetContext } from "./slack-event-processor";

export class SlackEventContextService {
    private readonly storage: SlackEventStorage;
    private readonly slack: SlackWebApi;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly slackWebApi: SlackWebApi };
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { slackWebApi: slack } = cx.gateways;
        this.storage = storage;
        this.slack = slack;
    }

    readonly exists = async (
        tenant: TenantContext,
        input: SlackConversationKey,
        signal: AbortSignal,
    ): Promise<boolean> => (await this.storage.findConversation(tenant, input, signal)) !== null;
    readonly isBotInitiatedThread = async (
        tenant: TenantContext,
        input: SlackConversationKey,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (input.threadTs === null) {
            return false;
        }
        const target = await this.storage.findTargetForBot(tenant, input.tenantId, input.botId, signal);
        if (target === null) {
            return false;
        }
        const messages = await this.slack.getThreadMessages(target.botToken, input.channelId, input.threadTs, signal);
        const parent = messages.find((message) => message.ts === input.threadTs);
        return parent?.botId !== null && parent?.botId !== undefined;
    };
    readonly resolve = async (
        tenant: TenantContext,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<SlackEventTargetContext | null> => {
        const target = await this.storage.findTargetForPayload(tenant, payload, signal);
        if (target === null) {
            return null;
        }
        const base = {
            botId: target.botId,
            botUserId: target.botUserId,
            tenantId: target.tenantId,
        };
        const event = payload.event;
        if (event.bot_id != null) {
            const appId = await this.slack.getBotAppId(target.botToken, event.bot_id, signal);
            const source =
                appId === null ? null : await this.storage.findSourceBot(tenant, target.tenantId, appId, signal);
            const allowed = source !== null && source !== target.botId;
            return {
                ...base,
                sender: {
                    botId: source ?? `external:${event.bot_id}`,
                    kind: "bot",
                    slackBotId: event.bot_id,
                    slackTeamId: payload.team_id,
                    targetAccess: allowed ? "allowed" : "denied",
                },
            };
        }
        const slackUserId = event.user ?? "unknown";
        return {
            ...base,
            sender: {
                kind: "user",
                slackTeamId: payload.team_id,
                slackUserId,
            },
        };
    };
}
