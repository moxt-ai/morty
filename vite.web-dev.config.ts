import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Deployed Worker origin proxied to when WEB_DEV_ORIGIN is unset. Never point
// this at an origin the user did not name.
const defaultDeployed = "https://morty.build";
const deployed = process.env["WEB_DEV_ORIGIN"] ?? defaultDeployed;

// Ask the OS for a free port above 10000 so concurrent web-dev servers never
// collide and never take a well-known dev port. Binding port 0 lets the OS
// assign one; the probe socket closes before Vite listens.
const randomPort = async (): Promise<number> => {
    for (let attempt = 0; ; attempt++) {
        const port = await new Promise<number>((resolve, reject) => {
            const probe = createServer();
            probe.unref();
            probe.once("error", reject);
            probe.listen(0, "localhost", () => {
                const assigned = probe.address();
                probe.close();
                if (assigned === null || typeof assigned === "string") {
                    reject(new Error("no port assigned"));
                    return;
                }
                resolve(assigned.port);
            });
        });
        if (port > 10000) {
            return port;
        }
        if (attempt >= 10) {
            throw new Error(`no free port above 10000 after ${attempt + 1} attempts`);
        }
    }
};
const port = await randomPort();

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
        port,
        strictPort: true,
        proxy: {
            "/morty/api": forward,
            "/morty/ws": { ...forward, ws: true },
        },
    },
});
