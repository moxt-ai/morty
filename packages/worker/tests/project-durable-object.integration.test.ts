import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { expect, test } from "vitest";
import { platformPeer } from "./support/platform-peer.ts";

const identitySchema = v.pipe(v.object({ projectId: v.string(), token: v.string(), userId: v.string() }), v.readonly());

test("Given project-scoped Chat requests, When users create and reopen workspaces, Then each Durable Object persists and isolates its SQLite state", async () => {
    const platform = await platformPeer();
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        loader: { ".md": "text", ".sql": "text" },
        platform: "browser",
        target: "es2022",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Missing Worker bundle");
    }
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            bindings: { APP_ORIGIN: "https://chat.test", ...platform.bindings },
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
                BOT_TRIGGER_RATE_LIMITER: { className: "BotTriggerRateLimiter", useSQLite: true },
                CHAT_PROJECTS: { className: "ProjectDurableObject", useSQLite: true },
            },
            modules: true,
            r2Buckets: ["CHAT_ATTACHMENTS_APAC", "CHAT_ATTACHMENTS_WNAM"],
            script: output.text,
        }),
    );
    try {
        const create = async () => {
            const response = await runtime.dispatchFetch(
                "https://chat.test/mobius-cloud/api/identity/anonymous-users",
                {
                    method: "POST",
                },
            );
            expect(response.status).toBe(201);
            return v.parse(identitySchema, await response.json());
        };
        const alice = await create();
        const bob = await create();
        const session = (projectId: string, token: string) =>
            runtime.dispatchFetch(`https://chat.test/mobius-cloud/api/projects/${projectId}/session`, {
                headers: { authorization: `Bearer ${token}` },
            });
        expect((await session(alice.projectId, alice.token)).status).toBe(200);
        expect((await session(bob.projectId, bob.token)).status).toBe(200);
        expect((await session(bob.projectId, alice.token)).status).toBe(401);
    } finally {
        await runtime.dispose();
        await platform.close();
    }
});
