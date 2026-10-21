import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

export default defineConfig({
    // Let Node strip dependency types without rewriting native class-field semantics.
    build: {
        external: [
            "**/third-party/mobius/**",
            `${realpathSync(fileURLToPath(new URL("../../third-party/mobius", import.meta.url))).replaceAll(
                "\\",
                "/",
            )}/**`,
        ],
    },
    testDir: ".",
    testMatch: ["*.e2e.test.ts", "*.browser-contract.test.ts"],
    globalSetup: "./infra/global-setup.ts",
    fullyParallel: true,
    // Each journey starts two Wrangler Workers and a local Runtime.
    workers: 1,
    timeout: Number(process.env["MOBIUS_E2E_TIMEOUT_MS"] ?? 600000),
    expect: { timeout: 30000 },
    reporter: "list",
});
