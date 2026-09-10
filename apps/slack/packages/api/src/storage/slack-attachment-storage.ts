export interface SlackAttachmentStorage {
    readonly get: (key: string, signal: AbortSignal) => Promise<Response | null>;
    readonly put: (key: string, response: Response, contentType: string, signal: AbortSignal) => Promise<void>;
}
