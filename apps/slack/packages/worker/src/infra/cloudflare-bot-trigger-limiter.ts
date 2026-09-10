import type { SlackConversationKey } from "@moxt-ai/app-slack-api";
import type { BotTriggerRateLimiter } from "./bot-trigger-rate-limiter";

export class CloudflareBotTriggerLimiter {
    readonly #namespace: DurableObjectNamespace<BotTriggerRateLimiter>;
    constructor(namespace: DurableObjectNamespace<BotTriggerRateLimiter>) {
        this.#namespace = namespace;
    }
    readonly admit = async (key: SlackConversationKey, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const id = this.#namespace.idFromName(`${key.tenantId}:${key.botId}:${key.channelId}:${key.threadTs ?? "top"}`);
        const admitted = await this.#namespace.get(id).admit(Date.now());
        signal.throwIfAborted();
        return admitted;
    };
}
