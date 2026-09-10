import type { SlackConversationKey } from "../components/slack/service/bot-run/slack-event-processor";

export interface BotTriggerLimiter {
    readonly admit: (key: SlackConversationKey, signal: AbortSignal) => Promise<boolean>;
}
