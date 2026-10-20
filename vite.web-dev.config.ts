import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Deployed Worker origin proxied to when WEB_DEV_ORIGIN is unset. Never point
// this at an origin the user did not name.
const defaultDeployed = "https://morty.build";
const deployed = process.env["WEB_DEV_ORIGIN"] ?? defaultDeployed;
// Same-origin forwarding: the deployed Worker rejects requests whose Origin
// differs from its own, so the proxy rewrites it. The agent reuses Node's
// environment-aware global agent; without it the proxy dials the origin
// directly, which is slow or reset on proxy-dependent networks.
const forward = {
    target: deployed,
    changeOrigin: true,
    secure: true,
    headers: { origin: deployed },
    agent: (await import("node:https")).globalAgent,
};

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./packages/web/src", import.meta.url)) }],
    },
    server: {
        host: "localhost",
        port: 5173,
        strictPort: true,
        proxy: {
            "/morty/api": forward,
            "/morty/ws": { ...forward, ws: true },
        },
    },
});
