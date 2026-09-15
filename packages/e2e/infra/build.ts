import { join } from "node:path";
import type { E2EHarness } from "./harness.ts";
import { repository } from "./local-stack.ts";

export async function buildLocalStack(harness: E2EHarness) {
    await harness.stage("build-mobius", () =>
        harness.run("pnpm", ["--filter", "@moxt-ai/mobius", "build"], { cwd: join(repository, "third-party/mobius") }),
    );
    await harness.stage("build-chat", () =>
        harness.run("pnpm", ["build", "--mode", "e2e"], { env: { NODE_ENV: "production" } }),
    );
}
