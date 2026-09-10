import * as v from "valibot";
import type { SlackQueueConsumer } from "../index.ts";
import type { SlackLogger } from "../infra/logger.ts";
import { queueMessageSchema, type SlackQueueMessage } from "../infra/queue-message.ts";

export class SlackQueueController {
    readonly #consumer: SlackQueueConsumer;
    readonly #logger: SlackLogger;
    constructor(consumer: SlackQueueConsumer, logger: SlackLogger) {
        this.#consumer = consumer;
        this.#logger = logger;
    }
    readonly consume = async (batch: MessageBatch<SlackQueueMessage>): Promise<void> => {
        await Promise.all(
            batch.messages.map(async (message) => {
                const parsed = v.safeParse(queueMessageSchema, message.body);
                if (!parsed.success) {
                    this.#logger.warn(
                        { component: "queue-controller", queueMessageId: message.id },
                        "Invalid Slack queue message acknowledged",
                    );
                    message.ack();
                    return;
                }
                try {
                    this.#logger.info(
                        {
                            attempts: message.attempts,
                            component: "queue-controller",
                            queueMessageId: message.id,
                        },
                        "Slack queue delivery started",
                    );
                    await this.#consumer.consume(parsed.output, AbortSignal.timeout(840_000));
                    message.ack();
                    this.#logger.info(
                        { component: "queue-controller", queueMessageId: message.id },
                        "Slack queue delivery acknowledged",
                    );
                } catch (error) {
                    this.#logger.error(
                        {
                            attempts: message.attempts,
                            component: "queue-controller",
                            err: error,
                            queueMessageId: message.id,
                        },
                        "Slack queue delivery failed",
                    );
                    message.retry({ delaySeconds: 30 });
                }
            }),
        );
    };
}
