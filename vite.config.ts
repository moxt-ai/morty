import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import * as v from "valibot";
import { defineConfig, type Plugin } from "vite";

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
const assetOrigin =
    cloudflareEnvironment === "staging"
        ? "https://assets.morty.paradev.biz"
        : cloudflareEnvironment === "production"
          ? "https://assets.morty.build"
          : undefined;

const agentConnectionInstructions: Plugin = {
    name: "morty-agent-connection-instructions",
    transformIndexHtml() {
        const instructions = readFileSync(
            new URL("./packages/web/content/instructions/connect.txt", import.meta.url),
            "utf8",
        )
            .replaceAll("{{BASE_URL}}", "the origin of the complete Morty URL supplied by the user")
            .replace(/<\/script/giu, "<\\/script");
        return [
            {
                tag: "script",
                attrs: { type: "text/plain", id: "morty-agent-instructions" },
                children: instructions,
                injectTo: "head",
            },
        ];
    },
};
export default defineConfig({
    ...(assetOrigin === undefined
        ? {}
        : {
              experimental: {
                  renderBuiltUrl: (filename: string) => `${assetOrigin}/${filename}`,
              },
          }),
    plugins: [
        agentConnectionInstructions,
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
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) }],
    },
    server: {
        allowedHosts: [".trycloudflare.com"],
        host: "localhost",
        port: 5173,
        strictPort: true,
    },
});
