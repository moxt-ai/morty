import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.{contract,integration,e2e}.test.ts"],
        // Scenarios start real isolates, and their Runtime and Platform waits allow up to 10 s. The test budget must
        // outlast those waits so a stuck wait fails with what it waited for.
        testTimeout: 30_000,
        coverage: {
            provider: "istanbul",
            reporter: ["text-summary", "json"],
            reportsDirectory: "../../coverage/worker",
            reportOnFailure: true,
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/testing/**", "tests/**", ...coverageConfigDefaults.exclude],
        },
    },
});
