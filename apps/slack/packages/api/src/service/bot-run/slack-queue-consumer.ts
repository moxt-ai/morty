import type { SlackLogger } from "../../infra/logger";
import type { SlackQueueMessage } from "../../infra/queue-message";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { TenantContext } from "../identity/tenant-context";
import type { SlackEventProcessor } from "./slack-event-processor";

export class SlackQueueConsumer {
    readonly #storage: SlackEventStorage;
    readonly #processor: SlackEventProcessor;
    readonly #logger: SlackLogger;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly services: { readonly eventProcessor: SlackEventProcessor };
        readonly logger: SlackLogger;
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { eventProcessor: processor } = cx.services;
        const { logger } = cx;
        this.#storage = storage;
        this.#processor = processor;
        this.#logger = logger;
    }
    readonly consume = async (
        tenant: TenantContext,
        message: SlackQueueMessage,
        signal: AbortSignal,
    ): Promise<void> => {
        const eventId = message.kind === "event" ? message.payload.event_id : message.input.eventId;
        if (
            message.kind === "event" &&
            !(await this.#storage.eventNeedsProcessing(tenant, tenant.tenantId, eventId, signal))
        ) {
            return;
        }
        if (message.kind === "pending-conversation") {
            this.#logger.info(
                {
                    component: "queue-consumer",
                    eventId: message.input.eventId,
                    messageKind: message.kind,
                    tenantId: message.input.tenantId,
                },
                "Consuming Slack queue message",
            );
            const payload = await this.#storage.findEvent(
                tenant,
                message.input.eventId,
                message.input.tenantId,
                signal,
            );
            if (payload !== null) {
                const result = await this.#processor.process(tenant, payload, signal);
                if (result.kind !== "conversation-queued") {
                    await this.#storage.markProcessed(tenant, eventId, "processed", Date.now(), signal);
                }
            }
            return;
        }
        this.#logger.info(
            {
                component: "queue-consumer",
                eventId: message.payload.event_id,
                eventType: message.payload.event.type,
                messageKind: message.kind,
            },
            "Consuming Slack queue message",
        );
        try {
            const eventType = message.payload.event.type;
            if (eventType === "app_uninstalled" || eventType === "tokens_revoked") {
                await this.#storage.markInstallationStatusByApp(
                    tenant,
                    message.payload.api_app_id,
                    eventType === "app_uninstalled" ? "uninstalled" : "token_revoked",
                    signal,
                );
            } else {
                const result = await this.#processor.process(tenant, message.payload, signal);
                if (result.kind === "conversation-queued") {
                    return;
                }
            }
            await this.#storage.markProcessed(tenant, message.payload.event_id, "processed", Date.now(), signal);
            this.#logger.info(
                { component: "queue-consumer", eventId: message.payload.event_id },
                "Slack queue message processed",
            );
        } catch (error) {
            signal.throwIfAborted();
            await this.#storage.markProcessed(tenant, message.payload.event_id, "failed", Date.now(), signal);
            this.#logger.error(
                { component: "queue-consumer", err: error, eventId: message.payload.event_id },
                "Slack queue message processing failed",
            );
            throw error;
        }
    };
}
