import type { ProjectQueueMessage, SlackQueueMessage } from "./queue-message.ts";

export class CloudflareSlackQueue {
    readonly #queue: Queue<ProjectQueueMessage>;
    readonly #projectId: string;
    constructor(queue: Queue<ProjectQueueMessage>, projectId: string) {
        this.#queue = queue;
        this.#projectId = projectId;
    }
    readonly send = async (message: SlackQueueMessage, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.#queue.send({ projectId: this.#projectId, message });
        signal.throwIfAborted();
    };
}
