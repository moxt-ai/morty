import * as v from "valibot";
import { queueMessageSchema } from "../../infra/queue-message.ts";
import type { SlackAppDirectory } from "../../storage/slack-app-directory.ts";
import { TenantStorageError } from "../../storage/tenant-storage-error.ts";
import { tenantContext } from "../identity/tenant-context.ts";
import type { SlackQueueConsumer } from "./slack-queue-consumer.ts";

export class TenantQueueConsumer {
    readonly #processor: SlackQueueConsumer;
    readonly #apps: SlackAppDirectory;
    constructor(cx: {
        readonly services: { readonly queueProcessor: SlackQueueConsumer };
        readonly storages: { readonly slackAppDirectory: SlackAppDirectory };
    }) {
        this.#processor = cx.services.queueProcessor;
        this.#apps = cx.storages.slackAppDirectory;
    }
    readonly consume = async (value: unknown, signal: AbortSignal): Promise<void> => {
        const message = v.parse(queueMessageSchema, value);
        if (message.kind === "pending-conversation") {
            await this.#processor.consume(tenantContext(message.input.tenantId), message, signal);
            return;
        }
        const app = await this.#apps.find(message.payload.api_app_id, signal);
        if (app === null) {
            throw new TenantStorageError();
        }
        await this.#processor.consume(app.tenant, message, signal);
    };
}
