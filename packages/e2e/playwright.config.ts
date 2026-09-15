import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: "*.e2e.test.ts",
    globalSetup: "./infra/global-setup.ts",
    // Build once; each journey owns its Chat storage, Runtime and Chrome.
    fullyParallel: true,
    workers: 2,
    timeout: Number(process.env.MOBIUS_E2E_TIMEOUT_MS ?? 600000),
    expect: { timeout: 30000 },
    reporter: "list",
});
