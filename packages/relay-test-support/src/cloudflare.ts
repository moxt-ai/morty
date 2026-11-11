import { fileURLToPath, URL as NodeURL } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import type { D1Database } from "@cloudflare/workers-types";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

type TestRelayBindings = {
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
};

import { miniflareDurableObjects } from "./miniflare-durable-objects.ts";

/** Prepare once per suite run; only immutable code is shared, never a runtime or its storage. */
export async function prepareTestMortyRelayBindings(workerEntryPoint?: string) {
    const bundle = await build({
        entryPoints: [workerEntryPoint ?? fileURLToPath(new NodeURL("./relay-worker-entry.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:*", "node:*"],
        loader: { ".txt": "text", ".sql": "text" },
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the Relay Worker bundle");
    }
    const script = output.text;
    return (allowedOrigins: ReadonlySet<string> = new Set(["*"])) => createRelayBindings(script, allowedOrigins);
}

/** Owns the real Cloudflare adapters for Computer/Worker integration scenarios. */
function createCloudflareRuntime(script: string, allowedOrigins: ReadonlySet<string>) {
    const options = {
        name: "morty-test-relay",
        modules: true,
        script,
        compatibilityDate: "2026-09-07",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["RELAY_DIRECTORY_DATABASE"],
        r2Buckets: ["CHAT_ATTACHMENTS_APAC"],
        ratelimits: {
            ANONYMOUS_CREATION_LIMITER: { namespace_id: "103001", simple: { limit: 1_000, period: 60 } },
        },
        bindings: {
            MORTY_ALLOWED_ORIGINS: JSON.stringify([...allowedOrigins]),
            MORTY_SESSION_SIGNING_SECRET: "local-development-only-session-signing-secret",
        },
        durableObjects: miniflareDurableObjects(new NodeURL("../wrangler.test.jsonc", import.meta.url)),
    } satisfies Parameters<typeof convertV4MiniflareOptions>[0];
    const runtime = new Miniflare(convertV4MiniflareOptions(options));
    return {
        runtime,
        configure: async (bindings: Readonly<Record<string, string>>) => {
            const origin = await runtime.ready;
            await runtime.setOptions(
                convertV4MiniflareOptions({
                    ...options,
                    host: origin.hostname,
                    port: Number.parseInt(origin.port, 10),
                    bindings: { ...options.bindings, ...bindings },
                }),
            );
        },
    };
}

async function migrate(database: D1Database, directory: NodeURL) {
    for (const migration of await readD1Migrations(fileURLToPath(directory))) {
        await database.batch(migration.queries.map((query) => database.prepare(query)));
    }
}

export async function createTestMortyRelayBindings(allowedOrigins: ReadonlySet<string> = new Set(["*"])) {
    const createBindings = await prepareTestMortyRelayBindings();
    return createBindings(allowedOrigins);
}

async function createRelayBindings(script: string, allowedOrigins: ReadonlySet<string>) {
    const { runtime, configure } = createCloudflareRuntime(script, allowedOrigins);
    try {
        const ready = await runtime.ready;
        const env = await runtime.getBindings<TestRelayBindings>();
        await migrate(env.RELAY_DIRECTORY_DATABASE, new NodeURL("../../relay/migrations/d1", import.meta.url));
        const request = async (input: Request): Promise<Response> => {
            const body = input.body === null ? undefined : await input.arrayBuffer();
            const result = await runtime.dispatchFetch(input.url, {
                method: input.method,
                headers: Object.fromEntries(input.headers),
                ...(body === undefined ? {} : { body }),
            });
            const hasBody = result.status !== 204 && result.status !== 205 && result.status !== 304;
            return new Response(hasBody ? await result.arrayBuffer() : null, {
                status: result.status,
                statusText: result.statusText,
                headers: Object.fromEntries(result.headers),
            });
        };
        return {
            env,
            origin: ready.origin,
            request,
            configure,
            cloudflare: runtime,
            [Symbol.asyncDispose]: () => runtime.dispose(),
        };
    } catch (cause) {
        await runtime.dispose();
        throw cause;
    }
}
