import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

export default defineConfig({
    // Let Node strip dependency types without rewriting native class-field semantics.
    build: {
        external: [
            "**/packages/cli/**",
            `${realpathSync(fileURLToPath(new URL("../cli", import.meta.url))).replaceAll("\\", "/")}/**`,
        ],
    },
    testDir: ".",
    testMatch: ["*.e2e.test.ts", "*.browser-contract.test.ts"],
    globalSetup: "./infra/global-setup.ts",
    fullyParallel: true,
    // Each journey starts two Wrangler Workers and a local Runtime.
    workers: 1,
    // On CI a journey gets one more attempt: local Wrangler Workers occasionally drop the connection between the Chat
    // and Platform Workers ("Network connection lost") while a journey sets up its Runtime. A journey that passes on
    // its second attempt is reported as flaky, not hidden, and one that fails twice still fails the run.
    retries: process.env["CI"] === "true" ? 1 : 0,
    timeout: Number(process.env["MORTY_E2E_TIMEOUT_MS"] ?? 600000),
    expect: { timeout: 30000 },
    // An action whose target never becomes actionable fails as an assertion does, instead of holding the shard until
    // the journey's timeout.
    use: { actionTimeout: 30000 },
    reporter: "list",
});
