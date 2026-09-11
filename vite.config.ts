import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import * as v from "valibot";
import { defineConfig } from "vite";

const sentry = v.parse(
    v.object({
        SENTRY_AUTH_TOKEN: v.optional(v.string()),
        SENTRY_ORG: v.optional(v.string()),
        SENTRY_PROJECT: v.optional(v.string()),
        VITE_SENTRY_RELEASE: v.optional(v.string()),
    }),
    process.env,
);

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        cloudflare(),
        ...(sentry.SENTRY_AUTH_TOKEN
            ? sentryVitePlugin({
                  org: v.parse(v.string(), sentry.SENTRY_ORG),
                  project: v.parse(v.string(), sentry.SENTRY_PROJECT),
                  authToken: sentry.SENTRY_AUTH_TOKEN,
                  telemetry: false,
                  errorHandler: (error) => {
                      throw error;
                  },
                  release: sentry.VITE_SENTRY_RELEASE ? { name: sentry.VITE_SENTRY_RELEASE } : {},
                  sourcemaps: {
                      assets: "./dist/client/**",
                      filesToDeleteAfterUpload: "./dist/client/**/*.map",
                  },
              }).map((plugin) => ({
                  ...plugin,
                  applyToEnvironment: (environment: { readonly name: string }) => environment.name === "client",
              }))
            : []),
    ],
    build: { sourcemap: "hidden" },
    resolve: {
        alias: [
            {
                find: "@moxt-ai/mobius-sdk/browser",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/mobius-sdk/src/browser.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-sdk/server",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/mobius-sdk/src/server.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-sdk/platform",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/mobius-sdk/src/platform.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-sdk/channel",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/mobius-sdk/src/channel.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-sdk",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/mobius-sdk/src/index.ts", import.meta.url),
                ),
            },
            {
                find: "@moxt-ai/mobius-protocol",
                replacement: fileURLToPath(
                    new URL("./third-party/mobius/packages/protocol/src/index.ts", import.meta.url),
                ),
            },
            { find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) },
        ],
    },
    server: {
        allowedHosts: [".trycloudflare.com"],
        host: "localhost",
        port: 5173,
        strictPort: true,
    },
});
