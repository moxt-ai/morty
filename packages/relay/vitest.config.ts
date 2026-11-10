import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const relayMigrationsPath = fileURLToPath(new URL("./migrations/d1", import.meta.url));

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const relayMigrations = await readD1Migrations(relayMigrationsPath);

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    d1Databases: ["TEST_UNINITIALIZED_SHARD"],
                    r2Buckets: ["R2_BUCKET_WNAM"],
                    bindings: {
                        MORTY_ALLOWED_ORIGINS: '["*"]',
                        TEST_RELAY_MIGRATIONS: relayMigrations,
                    },
                },
            }),
        ],
        test: {
            include: ["test/**/*.integration.test.ts"],
            setupFiles: ["./test/apply-migrations.ts"],
            // CI runs this suite alongside nine other matrix jobs (see .github/workflows/ci.yml),
            // so shared-runner contention can slow the ~200-round-trip WebSocket replay test well
            // beyond the default budget even though it normally finishes in a couple of seconds.
            testTimeout: 30_000,
            coverage: {
                provider: "istanbul",
                reporter: ["text-summary", "json"],
                reportsDirectory: "../../coverage/relay",
                reportOnFailure: true,
                include: ["src/**/*.{ts,tsx}"],
                exclude: ["**/*.d.ts", "**/testing/**"],
            },
        },
    };
});
