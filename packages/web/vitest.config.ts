import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: [
            {
                find: "@moxt-ai/mobius-sdk/channel",
                replacement: fileURLToPath(
                    new URL("../../third-party/mobius/packages/web-sdk/src/channel.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-sdk",
                replacement: fileURLToPath(
                    new URL("../../third-party/mobius/packages/web-sdk/src/index.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-protocol",
                replacement: fileURLToPath(
                    new URL("../../third-party/mobius/packages/protocol/src/index.ts", import.meta.url),
                ),
            },
            { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
        ],
    },
    test: {
        include: ["tests/{client,protocol}/**/*.{contract,integration}.test.ts"],
        testTimeout: 5_000,
    },
});
