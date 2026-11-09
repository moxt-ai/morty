import { createPlatformWorker } from "./platform-worker.ts";

export { ComputerRelay } from "./durable-objects/computer-relay.ts";
export * from "./platform-worker.ts";

export default createPlatformWorker();

// Preserve the retired namespace and its records without binding it to incoming requests.
export { DurableObject as ProjectDO, DurableObject as RuntimeRelay } from "cloudflare:workers";
