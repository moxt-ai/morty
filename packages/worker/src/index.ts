import type { CloudBindings } from "./contracts/cloud-bindings.ts";
import { logger } from "./infra/logger.ts";
import { fetchPublicApplication } from "./worker/application.ts";
import { withSetupFunnelEvents } from "./worker/composition/setup-funnel.ts";
import { withInstructionDocumentCache } from "./worker/middleware/instruction-document-cache.ts";

const fetch = withSetupFunnelEvents(withInstructionDocumentCache(fetchPublicApplication), logger);

export default {
    fetch,
} satisfies ExportedHandler<CloudBindings, unknown>;

export { ComputerRelay } from "./computer-relay/computer-relay.ts";
