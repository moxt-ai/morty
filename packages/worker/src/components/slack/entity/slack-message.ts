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
