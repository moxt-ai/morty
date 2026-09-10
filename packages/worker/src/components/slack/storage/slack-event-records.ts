export interface StoredSlackEventTarget {
    readonly botId: string;
    readonly botToken: string;
    readonly botUserId: string;
    readonly slackAppRecordId: number;
    readonly slackTeamId: string;
    readonly tenantId: string;
}

export interface StoredSlackConversation {
    readonly id: number;
    readonly latestEventTs: string | null;
    readonly conversationId: string;
}
