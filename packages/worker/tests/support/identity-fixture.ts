import { fileURLToPath } from "node:url";
import { miniflareDurableObjects } from "@moxt-ai/mobius-test/cloudflare";
import { startTestPlatform } from "@moxt-ai/mobius-test/platform";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { expect } from "vitest";
import worker from "../../src/application.ts";
import { APP_ORIGIN, clerk as issuer } from "./clerk.ts";

export function accountRequest(token?: string, projectId?: string): Request {
    return new Request(
        `${APP_ORIGIN}/mobius-cloud/api${projectId === undefined ? "" : `/projects/${projectId}`}/session`,
        { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } },
    );
}

export async function createIdentityFixture(
    options: {
        readonly appOrigin?: string;
        readonly platformAllowedOrigins?: ReadonlySet<string>;
        readonly workerEntryPoint?: string;
        readonly wranglerConfiguration?: URL;
    } = {},
) {
    const platform = await startTestPlatform(
        options.platformAllowedOrigins === undefined ? {} : { allowedOrigins: options.platformAllowedOrigins },
    );
    const appOrigin = options.appOrigin ?? APP_ORIGIN;
    const listener = new URL(appOrigin);
    const bundle = await build({
        entryPoints: [options.workerEntryPoint ?? fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
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
        throw new Error("Missing Chat Worker bundle");
    }
    const baseConfiguration = {
        APP_ORIGIN: appOrigin,
        AUTHENTICATION_BASE_URL: "https://identity.test",
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        MOBIUS_APP_ID: platform.appId,
        MOBIUS_APP_SECRET: platform.appCredential,
        MOBIUS_BASE_URL: platform.baseUrl,
    };
    const cloudflare = new Miniflare(
        convertV4MiniflareOptions({
            ...(options.appOrigin === undefined
                ? {}
                : { host: listener.hostname, port: Number.parseInt(listener.port, 10) }),
            bindings: baseConfiguration,
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: miniflareDurableObjects(
                options.wranglerConfiguration ?? new URL("../../../../wrangler.jsonc", import.meta.url),
            ),
            modules: true,
            r2Buckets: ["CHAT_ATTACHMENTS_APAC", "CHAT_ATTACHMENTS_WNAM"],
            script: output.text,
        }),
    );
    try {
        const ready = await cloudflare.ready;
        if (options.appOrigin !== undefined && ready.origin !== listener.origin) {
            throw new Error(`Chat Worker started at ${ready.origin} instead of ${listener.origin}`);
        }
        const cloudBindings = await cloudflare.getBindings();
        const projectObjects = cloudBindings["CHAT_PROJECTS"] as {
            readonly idFromName: (name: string) => unknown;
            readonly get: (
                id: unknown,
                options?: { readonly locationHint?: string },
            ) => {
                readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
            };
        };
        const chatProjects = {
            idFromName: (name: string) => projectObjects.idFromName(name),
            get: (id: unknown, options?: { readonly locationHint?: string }) => {
                const object = projectObjects.get(id, options);
                return {
                    fetch: async (request: Request) => {
                        const response = await object.fetch(request.url, {
                            method: request.method,
                            headers: request.headers,
                            ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
                        });
                        const hasBody = response.status !== 204 && response.status !== 205 && response.status !== 304;
                        return new Response(hasBody ? await response.arrayBuffer() : null, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    },
                };
            },
        };
        const environment = (appOrigin = APP_ORIGIN) => ({
            ...cloudBindings,
            ...baseConfiguration,
            APP_ORIGIN: appOrigin,
            ASSETS: { fetch: () => Promise.resolve(new Response()) },
            CHAT_PROJECTS: chatProjects,
            EVENTS: { send: () => Promise.resolve() },
            SLACK_MOBIUS_AUTH_TOKEN: "service-token",
            SLACK_OAUTH_STATE_SIGNING_KEY: "state-signing-key",
            SLACK_SERVER_BASE_URL: appOrigin,
            SLACK_TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
        });
        const createAnonymousUser = async () => {
            const response = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, { method: "POST" }),
                environment(),
            );
            expect(response.status).toBe(201);
            return v.parse(
                v.object({ token: v.string(), userId: v.string(), projectId: v.string() }),
                await response.json(),
            );
        };
        return {
            baseConfiguration,
            connectAgent: platform.connectAgent,
            createAnonymousUser,
            dispatchFetch: cloudflare.dispatchFetch.bind(cloudflare),
            environment,
            origin: ready.origin,
            close: async () => {
                await platform.close();
                await cloudflare.dispose();
            },
        };
    } catch (cause) {
        await cloudflare.dispose();
        await platform.close();
        throw cause;
    }
}
