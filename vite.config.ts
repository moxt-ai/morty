import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import * as v from "valibot";
import { defineConfig } from "vite";
import { bundleLicenses } from "./scripts/bundle-licenses.ts";

const sentry = v.parse(
    v.object({
        SENTRY_AUTH_TOKEN: v.optional(v.string()),
        SENTRY_ORG: v.optional(v.string()),
        SENTRY_PROJECT: v.optional(v.string()),
        VITE_SENTRY_RELEASE: v.optional(v.string()),
    }),
    process.env,
);
const workerConfig = process.env["MORTY_WORKER_CONFIG"];
const revision = process.env["MORTY_SETUP_REVISION"];
if (revision !== undefined && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("MORTY_SETUP_REVISION must be a full commit SHA");
}
const licenseFile = `assets/THIRD-PARTY-NOTICES-${revision ?? "local"}.txt`;
const assetOrigins =
    process.env["MORTY_ASSET_ORIGIN"] === undefined
        ? undefined
        : {
              application: v.parse(v.pipe(v.string(), v.url()), process.env["MORTY_APP_ORIGIN"]),
              generated: v.parse(v.pipe(v.string(), v.url()), process.env["MORTY_ASSET_ORIGIN"]),
          };

export default defineConfig({
    ...(assetOrigins === undefined
        ? {}
        : {
              experimental: {
                  // Public files ship with the Worker; only generated assets are uploaded to R2.
                  renderBuiltUrl: (filename: string, { type }: { readonly type: "asset" | "public" }) =>
                      `${type === "public" ? assetOrigins.application : assetOrigins.generated}/${filename}`,
              },
          }),
    plugins: [
        bundleLicenses({ kind: "asset", fileName: licenseFile }),
        react(),
        tailwindcss(),
        cloudflare(workerConfig === undefined ? {} : { configPath: workerConfig }),
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
    build: {
        sourcemap: "hidden",
        license: { fileName: "bundle-licenses.json" },
        rolldownOptions: {
            output: {
                postBanner: `/* License texts: /${licenseFile} on this asset's origin. */`,
            },
        },
    },
    resolve: {
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) }],
    },
    server: {
        allowedHosts: [".trycloudflare.com"],
        host: "localhost",
        port: 5173,
        strictPort: true,
    },
});
