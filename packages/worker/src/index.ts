import { fetchPublicApplication } from "./application.ts";
import { withInstructionDocumentCache } from "./gateway/instruction-document-cache.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

export { ProjectDurableObject } from "./components/project/project-durable-object.ts";

const fetch = withInstructionDocumentCache(fetchPublicApplication);

export default {
    fetch,
} satisfies ExportedHandler<CloudBindings, unknown>;
