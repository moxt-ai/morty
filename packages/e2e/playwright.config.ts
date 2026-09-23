import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: "*.e2e.test.ts",
    globalSetup: "./infra/global-setup.ts",
    fullyParallel: true,
    // Each journey starts two Wrangler Workers and a local Runtime.
    workers: 1,
    timeout: Number(process.env.MOBIUS_E2E_TIMEOUT_MS ?? 600000),
    expect: { timeout: 30000 },
    reporter: "list",
});
