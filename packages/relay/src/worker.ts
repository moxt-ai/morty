import { createPlatformWorker } from "./platform-worker.ts";

export { AccountDO } from "./durable-objects/account-do.ts";
export * from "./platform-worker.ts";

export default createPlatformWorker();
