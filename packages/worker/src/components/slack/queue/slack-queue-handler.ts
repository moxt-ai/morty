import * as v from "valibot";
import { queueMessageSchema, type SlackQueueMessage } from "../infra/queue-message.ts";
import type { SlackLogger } from "../infra/util/logger.ts";
import type { TenantQueueConsumer } from "../service/bot-run/tenant-queue-consumer.ts";

export class SlackQueueHandler {
    readonly #consumer: TenantQueueConsumer;
    readonly #logger: SlackLogger;
    constructor(consumer: TenantQueueConsumer, logger: SlackLogger) {
        this.#consumer = consumer;
        this.#logger = logger;
    }
    readonly consume = async (batch: MessageBatch<SlackQueueMessage>): Promise<void> => {
        await Promise.all(
            batch.messages.map(async (message) => {
                const parsed = v.safeParse(queueMessageSchema, message.body);
                if (!parsed.success) {
                    this.#logger.warn(
                        { component: "queue-handler", queueMessageId: message.id },
                        "Invalid Slack queue message acknowledged",
                    );
                    message.ack();
                    return;
                }
                try {
                    this.#logger.info(
                        {
                            attempts: message.attempts,
                            component: "queue-handler",
                            queueMessageId: message.id,
                        },
                        "Slack queue delivery started",
                    );
                    await this.#consumer.consume(parsed.output, AbortSignal.timeout(840_000));
                    message.ack();
                    this.#logger.info(
                        { component: "queue-handler", queueMessageId: message.id },
                        "Slack queue delivery acknowledged",
                    );
                } catch (error) {
                    this.#logger.error(
                        {
                            attempts: message.attempts,
                            component: "queue-handler",
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
