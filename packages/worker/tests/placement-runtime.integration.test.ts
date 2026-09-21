import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { platformPeer } from "./support/platform-peer.ts";

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
        const peer = await platformPeer({ redirectPlacement });
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
