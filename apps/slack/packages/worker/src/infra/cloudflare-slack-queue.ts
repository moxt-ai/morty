import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";

export class CloudflareSlackQueue {
    readonly #queue: Queue<SlackQueueMessage>;
    constructor(queue: Queue<SlackQueueMessage>) {
        this.#queue = queue;
    }
    readonly send = async (message: SlackQueueMessage, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.#queue.send(message);
        signal.throwIfAborted();
    };
}
