import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { conditions: ["morty-source"] },
    test: {
        fileParallelism: true,
        maxWorkers: 4,
        include: [
            "tests/{sessions,runtime}/**/*.{contract,integration}.test.ts",
            "tests/agents/**/*.integration.test.ts",
        ],
        testTimeout: 120_000,
    },
});
