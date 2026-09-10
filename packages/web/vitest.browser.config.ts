import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
    optimizeDeps: { include: ["qrcode"] },
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
    plugins: [react()],
    test: {
        include: ["tests/browser/**/*.e2e.test.tsx"],
        browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
        },
    },
});
