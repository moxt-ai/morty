import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.integration.test.ts"],
        exclude: [...configDefaults.exclude, "tests/relay/**"],
        // Scenarios start real isolates, and their Computer and Relay waits allow up to 10 s. The test budget must
        // outlast those waits so a stuck wait fails with what it waited for.
        testTimeout: 30_000,
    },
});
