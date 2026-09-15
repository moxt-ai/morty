import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.{contract,integration,e2e}.test.ts", "tests/slack/**/*.test.ts"],
        testTimeout: 5_000,
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
