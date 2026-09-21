import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    },
    test: {
        environment: "happy-dom",
        include: ["tests/**/*.integration.test.tsx"],
        testTimeout: 5_000,
        coverage: {
            provider: "istanbul",
            reporter: ["text-summary", "json"],
            reportsDirectory: "../../coverage/web",
            reportOnFailure: true,
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/**/*.d.ts", "src/routeTree.gen.ts", "tests/**", ...coverageConfigDefaults.exclude],
        },
    },
});
