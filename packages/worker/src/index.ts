import { fetchPublicApplication } from "./application.ts";
import { logger } from "./composition/application-context.ts";
import { withSetupFunnelEvents } from "./composition/setup-funnel.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { withInstructionDocumentCache } from "./middleware/instruction-document-cache.ts";

const fetch = withSetupFunnelEvents(withInstructionDocumentCache(fetchPublicApplication), logger);

export default {
    fetch,
} satisfies ExportedHandler<CloudBindings, unknown>;

export { ComputerRelay } from "./do/computer-relay.ts";
