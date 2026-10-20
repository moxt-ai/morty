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
const cloudflareEnvironment = v.parse(v.optional(v.picklist(["staging", "production"])), process.env["CLOUDFLARE_ENV"]);
const devApiOriginRaw = process.env["MORTY_DEV_API_ORIGIN"];
const devApiOrigin =
    devApiOriginRaw === undefined || devApiOriginRaw.length === 0
        ? undefined
        : v.parse(v.pipe(v.string(), v.url()), devApiOriginRaw);
const assetOrigin =
    cloudflareEnvironment === "staging"
        ? "https://assets.morty.paradev.biz"
        : cloudflareEnvironment === "production"
          ? "https://assets.morty.build"
          : undefined;

export default defineConfig({
    ...(assetOrigin === undefined
        ? {}
        : {
              experimental: {
                  renderBuiltUrl: (filename: string) => `${assetOrigin}/${filename}`,
              },
          }),
    plugins: [
        react(),
        tailwindcss(),
        ...(devApiOrigin === undefined ? [cloudflare()] : []),
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
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) }],
    },
    server: {
        allowedHosts: [".trycloudflare.com"],
        host: true,
        port: 5173,
        strictPort: true,
        ...(devApiOrigin === undefined
            ? {}
            : {
                  proxy: {
                      "/morty": {
                          target: devApiOrigin,
                          changeOrigin: true,
                          ws: true,
                          rewriteWsOrigin: true,
                      },
                      "/setup.md": { target: devApiOrigin, changeOrigin: true },
                      "/pair.md": { target: devApiOrigin, changeOrigin: true },
                      "/setup.mjs": { target: devApiOrigin, changeOrigin: true },
                  },
              }),
    },
});
