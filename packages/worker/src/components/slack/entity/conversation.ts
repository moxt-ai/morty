export type ContextLoadType =
    | "CHANNEL_FULL"
    | "CHANNEL_INCREMENTAL"
    | "THREAD_FULL_WITH_CHANNEL"
    | "THREAD_INCREMENTAL";

export type UserSender = {
    readonly kind: "user";
    readonly slackTeamId: string;
    readonly slackUserId: string;
};
export type BotSender = {
    readonly kind: "bot";
    readonly botId: string;
    readonly slackBotId: string;
    readonly slackTeamId: string;
    readonly targetAccess: "allowed" | "denied";
};
export type Sender = UserSender | BotSender;

export interface SlackMessageFile {
    readonly id: string;
    readonly mimetype: string | null;
    readonly name: string | null;
    readonly size: number | null;
    readonly urlPrivate: string | null;
}

export interface SlackConversationKey {
    readonly botId: string;
    readonly channelId: string;
    readonly tenantId: string;
    readonly threadTs: string | null;
}

export interface SlackConversationInput extends SlackConversationKey {
    readonly contextLoadType: ContextLoadType;
    readonly eventId: string;
    readonly eventTs: string;
    readonly files: readonly SlackMessageFile[];
    readonly sender: Sender;
    readonly text: string;
}

export interface SlackMessageReplyContext {
    readonly botToken: string;
    readonly channelId: string;
    readonly replyThreadTs: string | null;
    readonly conversationMappingId: number;
    readonly statusThreadTs: string | null;
    readonly tenantId: string;
}
