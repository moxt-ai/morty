import application from "./application.ts";
import { withInstructionDocumentCache } from "./gateway/instruction-document-cache.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

export { ProjectDurableObject } from "./components/project/project-durable-object.ts";
export { BotTriggerRateLimiter } from "./components/slack/do/bot-trigger-rate-limiter.ts";

const fetch = withInstructionDocumentCache(application.fetch);

export default {
    fetch,
    queue: application.queue,
} satisfies ExportedHandler<CloudBindings, unknown>;
