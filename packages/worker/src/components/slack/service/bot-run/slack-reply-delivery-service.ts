import type { SlackLogger } from "../../infra/util/logger";
import type { TenantContext } from "../identity/tenant-context";

export type MobiusTurnCompletion =
    | {
          readonly kind: "completed";
          readonly clientMessageId: string;
          readonly text: string;
      }
    | {
          readonly code: string;
          readonly kind: "failed";
          readonly clientMessageId: string;
      };

import type { SlackEventStorage } from "../../storage/slack-event-storage";

export type SlackReplyDeliveryResult =
    | { readonly kind: "already-delivered" }
    | { readonly kind: "failure-reported" }
    | { readonly kind: "reply-delivered" }
    | { readonly kind: "reply-suppressed" };

export class SlackReplyDeliveryService {
    readonly #runContexts: SlackEventStorage;
    readonly #slack: SlackWebApi;
    readonly #logger: SlackLogger;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly slackWebApi: SlackWebApi };
        readonly logger: SlackLogger;
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { slackWebApi: slack } = cx.gateways;
        const { logger } = cx;
        this.#runContexts = storage;
        this.#slack = slack;
        this.#logger = logger;
    }

    readonly deliver = async (
        tenant: TenantContext,
        tenantId: string,
        completion: MobiusTurnCompletion,
        signal: AbortSignal,
    ): Promise<SlackReplyDeliveryResult> => {
        const context = await this.#runContexts.claimMessageDelivery(
            tenant,
            tenantId,
            completion.clientMessageId,
            signal,
        );
        if (context === null) {
            this.#logger.info(
                { clientMessageId: completion.clientMessageId, component: "reply-delivery", tenantId },
                "Slack reply already delivered",
            );
            return { kind: "already-delivered" };
        }

        let result: SlackReplyDeliveryResult;
        try {
            if (completion.kind === "failed") {
                await this.#slack.postMessage(
                    context.botToken,
                    context.channelId,
                    `The bot run failed (${completion.code}). Please try again.`,
                    context.replyThreadTs,
                    signal,
                );
                result = { kind: "failure-reported" };
            } else if (completion.text.trim() === "[NO_REPLY]") {
                result = { kind: "reply-suppressed" };
            } else {
                await this.#slack.postMessage(
                    context.botToken,
                    context.channelId,
                    completion.text,
                    context.replyThreadTs,
                    signal,
                );
                result = { kind: "reply-delivered" };
            }

            await this.#runContexts.completeMessageDelivery(tenant, tenantId, completion.clientMessageId, signal);
            this.#logger.info(
                {
                    channelId: context.channelId,
                    clientMessageId: completion.clientMessageId,
                    component: "reply-delivery",
                    result: result.kind,
                    tenantId,
                },
                "Slack reply delivery completed",
            );
        } catch (error) {
            await this.#runContexts.releaseMessageDelivery(
                tenant,
                tenantId,
                completion.clientMessageId,
                AbortSignal.timeout(10_000),
            );
            this.#logger.error(
                { clientMessageId: completion.clientMessageId, component: "reply-delivery", err: error, tenantId },
                "Slack reply delivery failed",
            );
            throw error;
        }
        try {
            if (context.statusThreadTs !== null) {
                await this.#slack.setThreadStatus(
                    context.botToken,
                    context.channelId,
                    context.statusThreadTs,
                    "",
                    signal,
                );
            }
        } catch (error) {
            signal.throwIfAborted();
            this.#logger.warn(
                { clientMessageId: completion.clientMessageId, component: "reply-delivery", err: error, tenantId },
                "Slack thread status cleanup failed",
            );
        }
        return result;
    };
}

import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
