import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { platformPeer } from "./support/platform-peer.ts";

test.each([false, true])(
    "Given a Cloudflare Worker and Platform redirect=%s, When placement is requested, Then direct placement succeeds and redirects are rejected",
    async (redirectPlacement) => {
        const peer = await platformPeer({ redirectPlacement });
        let runtime: Miniflare | undefined;
        try {
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
            runtime = new Miniflare(
                convertV4MiniflareOptions({
                    modules: true,
                    script: output.text,
                    compatibilityDate: "2026-09-07",
                    bindings: peer.bindings,
                }),
            );
            const projectId = `prj_a01_${"a".repeat(24)}`;
            const response = await runtime.dispatchFetch(`http://worker.test/${projectId}`);
            expect(response.status).toBe(redirectPlacement ? 503 : 200);
            expect(await response.json()).toEqual(
                redirectPlacement
                    ? { error: { code: "PROJECT_PLACEMENT_UNAVAILABLE", message: "Project placement is unavailable." } }
                    : { projectId, d1ShardId: "apac-01", r2BucketId: "apac" },
            );
        } finally {
            await runtime?.dispose();
            await peer.close();
        }
    },
);
