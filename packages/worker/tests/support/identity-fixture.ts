import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { miniflareDurableObjects } from "@moxt-ai/mobius-test/cloudflare";
import { createResponseLossProxy } from "@moxt-ai/mobius-test/response-loss-proxy";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { expect } from "vitest";
import worker from "../../src/application.ts";
import { startTestPlatform } from "./test-platform.ts";

export const AUTH_TIME = new Date("2026-09-07T00:00:00.000Z");
export const APP_ORIGIN = "http://localhost:5173";

export function accountRequest(token?: string, projectId?: string): Request {
    return new Request(`${APP_ORIGIN}/morty/api${projectId === undefined ? "" : `/projects/${projectId}`}/session`, {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
}

// A loopback port must be free when workerd binds it. Choosing one ahead of time and releasing it leaves a window in
// which another listener (such as a fixture in a parallel test file) can take it, so a port taken in that window is
// retried with a fresh one.
const CHAT_WORKER_START_ATTEMPTS = 3;

function isAddressInUse(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ERR_ADDRESS_IN_USE";
}

async function loopbackOrigin(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a Chat Worker port");
    }
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    return `http://127.0.0.1:${address.port}`;
}

/** Disposes a runtime whose startup failed. Miniflare's dispose rethrows that startup failure, which the caller already has. */
async function disposeFailedRuntime(runtime: Miniflare): Promise<void> {
    await runtime.dispose().catch(() => undefined);
}

export async function createIdentityFixture(
    options: {
        /** Serve the Chat Worker on a free loopback port and use that origin as APP_ORIGIN. */
        readonly listenOnLoopback?: true;
        readonly loseTurnResponses?: true;
        readonly platformAllowedOrigins?: ReadonlySet<string>;
        readonly workerEntryPoint?: string;
        readonly wranglerConfiguration?: URL;
    } = {},
) {
    const platform = await startTestPlatform(
        options.platformAllowedOrigins === undefined ? {} : { allowedOrigins: options.platformAllowedOrigins },
    );
    const network = options.loseTurnResponses === true ? await createResponseLossProxy(platform.baseUrl) : null;
    try {
        const bundle = await build({
            entryPoints: [options.workerEntryPoint ?? fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
            bundle: true,
            external: ["cloudflare:*", "node:*"],
            format: "esm",
            loader: { ".txt": "text", ".sql": "text" },
            platform: "browser",
            target: "es2022",
            write: false,
        });
        const output = bundle.outputFiles[0];
        if (output === undefined) {
            throw new Error("Missing Chat Worker bundle");
        }
        const startChatWorker = async () => {
            for (let attempt = 1; ; attempt += 1) {
                // Choose the port as late as possible: the Platform and the bundle are ready by now.
                const appOrigin = options.listenOnLoopback === true ? await loopbackOrigin() : APP_ORIGIN;
                const listener = new URL(appOrigin);
                const baseConfiguration = {
                    APP_ORIGIN: appOrigin,
                    AUTHENTICATION_BASE_URL: "https://identity.test",
                    MOBIUS_APP_ID: platform.appId,
                    MOBIUS_APP_SECRET: platform.appCredential,
                    MOBIUS_BASE_URL: network?.origin ?? platform.baseUrl,
                };
                const runtimeOptions = {
                    ...(options.listenOnLoopback === true
                        ? { host: listener.hostname, port: Number.parseInt(listener.port, 10) }
                        : {}),
                    bindings: baseConfiguration,
                    compatibilityDate: "2026-09-07",
                    compatibilityFlags: ["nodejs_compat"],
                    durableObjects: miniflareDurableObjects(
                        options.wranglerConfiguration ?? new URL("../../../../wrangler.jsonc", import.meta.url),
                    ),
                    modules: true,
                    r2Buckets: ["CHAT_ATTACHMENTS_APAC"],
                    script: output.text,
                } satisfies Parameters<typeof convertV4MiniflareOptions>[0];
                const runtime = new Miniflare(convertV4MiniflareOptions(runtimeOptions));
                try {
                    const ready = await runtime.ready;
                    if (options.listenOnLoopback === true && ready.origin !== listener.origin) {
                        throw new Error(`Chat Worker started at ${ready.origin} instead of ${listener.origin}`);
                    }
                    return { baseConfiguration, cloudflare: runtime, ready, runtimeOptions };
                } catch (cause) {
                    await disposeFailedRuntime(runtime);
                    if (
                        options.listenOnLoopback !== true ||
                        !isAddressInUse(cause) ||
                        attempt === CHAT_WORKER_START_ATTEMPTS
                    ) {
                        throw cause;
                    }
                }
            }
        };
        const { baseConfiguration, cloudflare, ready, runtimeOptions } = await startChatWorker();
        try {
            let cloudBindings = await cloudflare.getBindings();
            let projectObjects = await cloudflare.getDurableObjectNamespace("CHAT_PROJECTS");
            const chatProjects = {
                idFromName: (name: string) => projectObjects.idFromName(name),
                get: (
                    id: ReturnType<typeof projectObjects.idFromName>,
                    options?: Parameters<typeof projectObjects.get>[1],
                ) => {
                    const object = projectObjects.get(id, options);
                    return {
                        fetch: async (request: Request) => {
                            const response = await object.fetch(request.url, {
                                method: request.method,
                                headers: [...request.headers],
                                ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
                            });
                            const hasBody =
                                response.status !== 204 && response.status !== 205 && response.status !== 304;
                            return new Response(hasBody ? await response.arrayBuffer() : null, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: [...response.headers],
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
            });
            const createAnonymousUser = async () => {
                const response = await worker.fetch(
                    new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, { method: "POST" }),
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
                network,
                connectAgent: platform.connectAgent,
                platformRequest: platform.app.request,
                createAnonymousUser,
                dispatchFetch: cloudflare.dispatchFetch.bind(cloudflare),
                environment,
                origin: ready.origin,
                changePlatformOrigin: async (origin: string) => {
                    baseConfiguration.MOBIUS_BASE_URL = origin;
                    await cloudflare.setOptions(
                        convertV4MiniflareOptions({ ...runtimeOptions, bindings: baseConfiguration }),
                    );
                    cloudBindings = await cloudflare.getBindings();
                    projectObjects = await cloudflare.getDurableObjectNamespace("CHAT_PROJECTS");
                },
                close: async () => {
                    try {
                        await network?.close();
                        await platform.close();
                    } finally {
                        await cloudflare.dispose();
                    }
                },
            };
        } catch (cause) {
            await disposeFailedRuntime(cloudflare);
            throw cause;
        }
    } catch (cause) {
        await network?.close();
        await platform.close();
        throw cause;
    }
}
