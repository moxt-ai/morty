import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: "*.e2e.test.ts",
    // The journeys own local Workers and Chrome; serialize their shared builds.
    workers: 1,
    timeout: Number(process.env.MOBIUS_E2E_TIMEOUT_MS ?? 600000),
    expect: { timeout: 30000 },
    reporter: "list",
});
