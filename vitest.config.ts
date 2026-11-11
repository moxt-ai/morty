import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { conditions: ["morty-source"] },
    test: {
        exclude: [...configDefaults.exclude, "packages/cli/tests/**"],
        fileParallelism: true,
        maxWorkers: 4,
        include: ["packages/*/tests/**/*.contract.test.ts", "packages/*/tests/**/*.integration.test.ts"],
        testTimeout: 15_000,
    },
});
