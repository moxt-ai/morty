import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // In-process ACP endpoints and the real daemon share the SDK's builder symbols.
        dedupe: ["@agentclientprotocol/sdk"],
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    },
    test: {
        environment: "happy-dom",
        environmentOptions: {
            happyDOM: {
                settings: {
                    // The page and the Platform differ only by port here, so happy-dom preflights the Platform's file
                    // reads. Its preflight lists CORS-safelisted headers such as Accept, which browsers leave out,
                    // and the Platform rightly refuses them. Browsers send these reads, so the tests do too.
                    fetch: { disableSameOriginPolicy: true },
                },
            },
        },
        // Each file owns real Chat and Platform isolates. Bound their concurrent startup.
        maxWorkers: 2,
        include: ["tests/**/*.integration.test.tsx"],
        // Scenarios start real isolates, and the harness waits up to 12 s for a view (`waitForView`) and 10 s for the
        // WebSocket bridge. The test budget must outlast those waits so a stuck wait fails with what it waited for.
        testTimeout: 30_000,
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
