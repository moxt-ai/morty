import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import {
    createPlatformGateways,
    createTestMobiusPlatformApp,
    type PlatformRelayBindings,
} from "@moxt-ai/mobius-test/app";
import { FakeClerk } from "@moxt-ai/mobius-test/clerk";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { miniflareDurableObjects } from "../support/miniflare-durable-objects.ts";

const platformDirectory = new URL(
    "../../../../third-party/mobius/packages/relay-cloudflare-platform/",
    import.meta.url,
);

export async function createMobiusPlatformFixture() {
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
                allowedOrigins: new Set(),
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
        const server = createServer(async (request, response) => {
            try {
                const headers = new Headers();
                for (const [name, value] of Object.entries(request.headers)) {
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            headers.append(name, item);
                        }
                    } else if (value !== undefined) {
                        headers.set(name, value);
                    }
                }
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                    chunks.push(Buffer.from(chunk));
                }
                const result = await app.request(
                    new Request(new URL(request.url ?? "/", "http://platform.test"), {
                        method: request.method ?? "GET",
                        headers,
                        signal: AbortSignal.timeout(15_000),
                        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
                    }),
                );
                response.writeHead(result.status, Object.fromEntries(result.headers));
                response.end(Buffer.from(await result.arrayBuffer()));
            } catch {
                response.writeHead(500);
                response.end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected the Platform HTTP address");
        }
        return {
            app,
            attachments: bindings.R2_BUCKET_APAC,
            appId: application.appId,
            appCredential: application.defaultCredential.credential,
            developerToken,
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: async () => {
                server.closeAllConnections();
                try {
                    await new Promise<void>((resolve, reject) =>
                        server.close((error) => (error ? reject(error) : resolve())),
                    );
                } finally {
                    await platform.dispose();
                }
            },
        };
    } catch (cause) {
        await platform.dispose();
        throw cause;
    }
}
