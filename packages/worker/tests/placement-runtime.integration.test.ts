import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";

async function placementPeer(redirect: boolean) {
    const credential = `mapp_${"a".repeat(22)}_${"b".repeat(43)}`;
    const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (redirect && !request.url?.endsWith("?resolved")) {
            response.writeHead(302, { location: `${request.url}?resolved` }).end();
            return;
        }
        response.writeHead(200).end(JSON.stringify({ location: "apac" }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "localhost", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing placement peer address");
    }
    return {
        bindings: {
            MOBIUS_APP_ID: "cloud-app",
            MOBIUS_APP_SECRET: credential,
            MOBIUS_BASE_URL: `http://localhost:${address.port}`,
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        },
    };
}

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./support/placement-worker.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
});
const output = bundle.outputFiles[0];
if (output === undefined) {
    throw new Error("Missing Worker bundle");
}

test("Given a Cloudflare Worker, When Platform placement is requested, Then direct responses succeed and redirects are rejected", async () => {
    for (const redirectPlacement of [false, true]) {
        const peer = await placementPeer(redirectPlacement);
        let runtime: Miniflare | undefined;
        try {
            runtime = new Miniflare(
                convertV4MiniflareOptions({
                    modules: true,
                    script: output.text,
                    compatibilityDate: "2026-09-07",
                    bindings: peer.bindings,
                }),
            );
            const projectId = `prj_ap_01_${"a".repeat(24)}`;
            const response = await runtime.dispatchFetch(`http://worker.test/${projectId}`);
            expect(response.status).toBe(redirectPlacement ? 503 : 200);
            expect(await response.json()).toEqual(
                redirectPlacement
                    ? { error: { code: "PROJECT_PLACEMENT_UNAVAILABLE", message: "Project placement is unavailable." } }
                    : { location: "apac" },
            );
        } finally {
            await runtime?.dispose();
            await peer.close();
        }
    }
});
