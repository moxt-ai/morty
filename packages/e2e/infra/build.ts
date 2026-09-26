import type { E2EHarness } from "./harness.ts";

export async function buildLocalStack(harness: E2EHarness) {
    await harness.stage("build-chat", () => harness.run("pnpm", ["build"], { env: { NODE_ENV: "production" } }));
}
