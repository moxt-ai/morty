import { fetchPublicApplication } from "./application.ts";
import { withInstructionDocumentCache } from "./gateway/instruction-document-cache.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

export { ProjectDurableObject } from "./components/project/project-durable-object.ts";

const fetch = withInstructionDocumentCache(fetchPublicApplication);

export default {
    fetch,
    queue: () => Promise.resolve(),
} satisfies ExportedHandler<CloudBindings, unknown>;
