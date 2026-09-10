import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src/mobius", import.meta.url)) } },
    test: {
        include: ["tests/**/*.{contract,integration,e2e}.test.ts", "tests/slack/**/*.test.ts"],
        testTimeout: 5_000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["packages/worker/src/**/*.ts"],
            exclude: ["packages/worker/src/testing/**", "tests/**", ...coverageConfigDefaults.exclude],
        },
    },
});
