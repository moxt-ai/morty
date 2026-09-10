import { createCloudApplication } from "./components/cloud/http/create-application.ts";
import type { SlackQueueMessage } from "./components/slack/infra/queue-message.ts";
import { createCloudDependencies } from "./di/create-dependencies.ts";
import { createCloudInfrastructure } from "./di/create-infrastructure.ts";
import type { CloudBindings } from "./gateway/business-gateway.ts";

const application = createCloudApplication();

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        const cx = createCloudDependencies(createCloudInfrastructure(bindings));
        return new URL(request.url).pathname.startsWith("/mobius-cloud/api/")
            ? await application.fetch(request, cx, context)
            : await cx.gateways.businesses.fetch(request, context);
    },
    async queue(batch, bindings): Promise<void> {
        const cx = createCloudDependencies(createCloudInfrastructure(bindings));
        await cx.gateways.businesses.consumeQueue(batch);
    },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
