import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import {
    createPlatformGateways,
    createTestMobiusPlatformApp,
    type PlatformRelayBindings,
} from "@moxt-ai/mobius-test/app";
import { FakeClerk } from "@moxt-ai/mobius-test/clerk";
import { convertV4MiniflareOptions, Miniflare, WebSocketPair, WorkerResponse } from "@moxt-ai/mobius-test/cloudflare";
import { createFakeAgentDaemonRuntime } from "@moxt-ai/mobius-test/platform-agent-daemon";
import { serveTestApp } from "@moxt-ai/mobius-test/server";
import { build } from "esbuild";
import * as v from "valibot";
import { miniflareDurableObjects } from "../support/miniflare-durable-objects.ts";

export async function createMobiusPlatformFixture(
    options: { readonly allowedOrigins?: ReadonlySet<string>; readonly platformDirectory?: URL } = {},
) {
    const platformDirectory =
        options.platformDirectory ??
        new URL("../../../../third-party/mobius/packages/relay-cloudflare-platform/", import.meta.url);
    const cancellation = new AbortController();
    const runtimes: Awaited<ReturnType<typeof createFakeAgentDaemonRuntime>>[] = [];
    const previousResponse = globalThis.Response;
    const previousWebSocketPair = Reflect.get(globalThis, "WebSocketPair");
    globalThis.Response = WorkerResponse as unknown as typeof Response;
    Reflect.set(globalThis, "WebSocketPair", WebSocketPair);
    const clerk = new FakeClerk();
    const developerToken = clerk.session("developer-1", clerk.defaultOrganizationId);
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("src/worker.ts", platformDirectory))],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the Platform Worker bundle");
    }
    const platform = new Miniflare(
        convertV4MiniflareOptions({
            name: "platform",
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-03",
            d1Databases: ["PLATFORM_DIRECTORY_DATABASE"],
            kvNamespaces: ["APP_CREDENTIAL_CACHE"],
            r2Buckets: ["R2_BUCKET_APAC", "R2_BUCKET_WNAM"],
            bindings: {
                MOBIUS_PLATFORM_ALLOWED_ORIGINS: "[]",
                MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
            },
            durableObjects: miniflareDurableObjects(new URL("wrangler.jsonc", platformDirectory)),
        }),
    );
    try {
        await platform.ready;
        const bindings = await platform.getBindings<PlatformRelayBindings>();
        for (const [database, directory] of [
            [bindings.PLATFORM_DIRECTORY_DATABASE, new URL("migrations/d1", platformDirectory)],
        ] as const) {
            for (const migration of await readD1Migrations(fileURLToPath(directory))) {
                await database.batch(migration.queries.map((query) => database.prepare(query)));
            }
        }
        const app = createTestMobiusPlatformApp(
            {
                bindings,
                developerAuthenticator: clerk.authenticator,
                operatorSubjects: new Set(["developer-1"]),
                allowedOrigins: new Set(options.allowedOrigins),
            },
            createPlatformGateways,
        );
        const headers = {
            authorization: `Bearer ${developerToken}`,
            "x-mobius-oidc-provider": "clerk",
            "content-type": "application/json",
        };
        const tenantResponse = await app.request("/mobius/api/dashboard/v1/platform/tenants", {
            headers,
        });
        const { tenants } = v.parse(
            v.object({ tenants: v.array(v.object({ tenantId: v.string() })) }),
            await tenantResponse.json(),
        );
        const tenant = tenants[0];
        if (tenant === undefined) {
            throw new Error("Expected the developer's active organization");
        }
        const applicationResponse = await app.request("/mobius/api/dashboard/v1/apps", {
            method: "POST",
            headers,
            body: JSON.stringify({ displayName: "Cloud test app", tenantId: tenant.tenantId }),
        });
        const application = v.parse(
            v.object({ appId: v.string(), defaultCredential: v.object({ credential: v.string() }) }),
            await applicationResponse.json(),
        );
        const server = await serveTestApp({ app, signal: cancellation.signal, onServerMessage: () => undefined });
        return {
            app,
            attachments: bindings.R2_BUCKET_APAC,
            appId: application.appId,
            appCredential: application.defaultCredential.credential,
            developerToken,
            baseUrl: server.origin,
            connectAgent: async (projectId: string) => {
                const runtime = await createFakeAgentDaemonRuntime({
                    credential: application.defaultCredential.credential,
                    projectId,
                    server: app,
                    signal: cancellation.signal,
                });
                runtimes.push(runtime);
                return { failure: runtime.failure, runtimeId: runtime.runtimeId };
            },
            close: async () => {
                try {
                    await Promise.all(runtimes.splice(0).map(async (runtime) => runtime[Symbol.asyncDispose]()));
                } finally {
                    cancellation.abort(new Error("Mobius Platform fixture stopped"));
                    try {
                        await server[Symbol.asyncDispose]();
                    } finally {
                        if (previousWebSocketPair === undefined) {
                            Reflect.deleteProperty(globalThis, "WebSocketPair");
                        } else {
                            Reflect.set(globalThis, "WebSocketPair", previousWebSocketPair);
                        }
                        globalThis.Response = previousResponse;
                        await platform.dispose();
                    }
                }
            },
        };
    } catch (cause) {
        if (previousWebSocketPair === undefined) {
            Reflect.deleteProperty(globalThis, "WebSocketPair");
        } else {
            Reflect.set(globalThis, "WebSocketPair", previousWebSocketPair);
        }
        globalThis.Response = previousResponse;
        await platform.dispose();
        throw cause;
    }
}
