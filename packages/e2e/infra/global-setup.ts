import { buildLocalStack } from "./build.ts";
import { runE2E } from "./harness.ts";

export default async function globalSetup() {
    await runE2E("chat-e2e-build", buildLocalStack);
}
