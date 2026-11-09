import { createPlatformWorker } from "./platform-worker.ts";

export { ComputerDO } from "./durable-objects/computer-do.ts";
export * from "./platform-worker.ts";

export default createPlatformWorker();
