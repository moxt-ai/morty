import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import { createCloudApplication } from "./di/create-application.ts";
import type { CloudBindings } from "./gateway/business-gateway.ts";

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        const injector = createCloudApplication(bindings);
        try {
            return await injector.resolve("application").fetch(request, context);
        } finally {
            await injector.dispose();
        }
    },
    async queue(batch, bindings): Promise<void> {
        const injector = createCloudApplication(bindings);
        try {
            await injector.resolve("application").consumeQueue(batch);
        } finally {
            await injector.dispose();
        }
    },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
