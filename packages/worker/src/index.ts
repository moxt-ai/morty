import { fetchPublicApplication } from "./application.ts";
import { logger } from "./composition/application-context.ts";
import { withSetupFunnelEvents } from "./composition/setup-funnel.ts";
import { withInstructionDocumentCache } from "./gateway/instruction-document-cache.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

const fetch = withSetupFunnelEvents(withInstructionDocumentCache(fetchPublicApplication), logger);

export default {
    fetch,
} satisfies ExportedHandler<CloudBindings, unknown>;

export { ComputerRelay } from "../../relay/src/durable-objects/computer-relay.ts";
