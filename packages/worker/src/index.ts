import { fetchPublicApplication } from "./application.ts";
import { logger } from "./composition/application-context.ts";
import { withSetupFunnelEvents } from "./composition/setup-funnel.ts";
import { withInstructionDocumentCache } from "./gateway/instruction-document-cache.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

export { ChatWebSocketDurableObject } from "./components/chat/chat-websocket-durable-object.ts";
export { ProjectDurableObject } from "./components/project/project-durable-object.ts";

const fetch = withSetupFunnelEvents(withInstructionDocumentCache(fetchPublicApplication), logger);

export default {
    fetch,
} satisfies ExportedHandler<CloudBindings, unknown>;
