import * as v from "valibot";
import { queueMessageSchema } from "../../infra/queue-message";
import type { SlackAppDirectory } from "../../storage/slack-app-directory";
import { TenantStorageError } from "../../storage/tenant-storage-error";
import type { TenantShardingDirectory } from "../identity/tenant-context";
import type { SlackQueueConsumer } from "./slack-queue-consumer";

export class TenantQueueConsumer {
    readonly processor: SlackQueueConsumer;
    readonly tenants: TenantShardingDirectory;
    readonly apps: SlackAppDirectory;
    constructor(cx: {
        readonly services: { readonly queueProcessor: SlackQueueConsumer };
        readonly gateways: {
            readonly tenantShardingDirectory: TenantShardingDirectory;
            readonly slackAppDirectory: SlackAppDirectory;
        };
    }) {
        const { queueProcessor: processor } = cx.services;
        const { tenantShardingDirectory: tenants, slackAppDirectory: apps } = cx.gateways;
        this.processor = processor;
        this.tenants = tenants;
        this.apps = apps;
    }

    readonly consume = async (value: unknown, signal: AbortSignal): Promise<void> => {
        const message = v.parse(queueMessageSchema, value);
        switch (message.kind) {
            case "pending-conversation": {
                const tenant = await this.tenants.resolve(message.input.tenantId, signal);
                await this.processor.consume(tenant, message, signal);
                return;
            }
            case "event": {
                const app = await this.apps.find(message.payload.api_app_id, signal);
                if (app === null) {
                    throw new TenantStorageError();
                }
                await this.processor.consume(app.tenant, message, signal);
                return;
            }
        }
    };
}
