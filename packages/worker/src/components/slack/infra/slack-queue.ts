import type { SlackQueueMessage } from "./queue-message";

export interface SlackQueue {
    readonly send: (message: SlackQueueMessage, signal: AbortSignal) => Promise<void>;
}
