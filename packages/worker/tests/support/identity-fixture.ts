import { fileURLToPath } from "node:url";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import { createResponseLossProxy } from "@morty-build/relay-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect } from "vitest";
import { createSessionExecutionProxy } from "../../../../tests/support/session-execution-proxy.ts";
import worker from "../../src/application.ts";

/** A fresh client-held key naming one anonymous user creation. */
export const anonymousCreationKey = (): string =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

import { startTestRelay } from "./test-relay.ts";

export const AUTH_TIME = new Date("2026-09-07T00:00:00.000Z");
export const APP_ORIGIN = "http://localhost:5173";

export function accountRequest(token?: string, computerId?: string): Request {
    return new Request(`${APP_ORIGIN}/morty/api${computerId === undefined ? "" : `/computers/${computerId}`}/session`, {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
}

type IdentityFixtureOptions = {
    /** Serve the Chat Worker on a free loopback port and use that origin as APP_ORIGIN. */
    readonly listenOnLoopback?: true;
    readonly loseTurnResponses?: true;
    readonly delayExecutionReads?: true;
    readonly relayAllowedOrigins?: ReadonlySet<string>;
    readonly workerEntryPoint?: string;
};

export async function createIdentityFixture(options: IdentityFixtureOptions = {}) {
    const createFixture = await prepareIdentityFixture(options);
    return createFixture();
}

/** Call in beforeAll so each suite run rebuilds its inputs, including watch reruns. */
export async function prepareIdentityFixture(options: IdentityFixtureOptions = {}) {
    const createBindings = await prepareTestMortyRelayBindings(
        options.workerEntryPoint ?? fileURLToPath(new URL("./credential-storage-worker.ts", import.meta.url)),
    );
    return () => startIdentityFixture(options, createBindings);
}

async function startIdentityFixture(
    options: IdentityFixtureOptions,
    createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>,
) {
    const relay = await startTestRelay(
        options.relayAllowedOrigins === undefined ? {} : { allowedOrigins: options.relayAllowedOrigins },
        createBindings,
    );
    // The public Chat and Relay origins are distinct while their requests share the same Computer namespace.
    const chatNetwork = options.listenOnLoopback === true ? await createResponseLossProxy(relay.baseUrl) : null;
    const network = options.loseTurnResponses === true ? await createResponseLossProxy(relay.baseUrl) : null;
    const executionNetwork =
        options.delayExecutionReads === true ? await createSessionExecutionProxy(relay.baseUrl) : null;
    try {
        const cloudflare = relay.cloudflare;
        const ready = new URL(chatNetwork?.origin ?? relay.baseUrl);
        const baseConfiguration = {
            APP_ORIGIN: options.listenOnLoopback === true ? ready.origin : APP_ORIGIN,
            MORTY_SERVICE_SECRET: relay.appCredential,
            MORTY_RELAY_URL: executionNetwork?.origin ?? network?.origin ?? relay.baseUrl,
        };
        await relay.configure(baseConfiguration);
        let cloudBindings = await cloudflare.getBindings();
        let computerObjects = await cloudflare.getDurableObjectNamespace("COMPUTER_RELAY");
        const chatProjects = {
            idFromName: (name: string) => computerObjects.idFromName(name),
            get: (
                id: ReturnType<typeof computerObjects.idFromName>,
                options?: Parameters<typeof computerObjects.get>[1],
            ) => {
                const object = computerObjects.get(id, options);
                return {
                    fetch: async (request: Request) => {
                        const response = await object.fetch(request.url, {
                            method: request.method,
                            headers: [...request.headers],
                            ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
                        });
                        const hasBody = response.status !== 204 && response.status !== 205 && response.status !== 304;
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
            COMPUTER_RELAY: chatProjects,
        });
        /** Restarts the Worker with the changed deployment settings, keeping its storage. */
        const reconfigure = async () => {
            await relay.configure(baseConfiguration);
            cloudBindings = await cloudflare.getBindings();
            computerObjects = await cloudflare.getDurableObjectNamespace("COMPUTER_RELAY");
        };
        const createAnonymousUser = async () => {
            const response = await worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ creationKey: anonymousCreationKey() }),
                }),
                environment(),
            );
            expect(response.status).toBe(201);
            return v.parse(
                v.object({ token: v.string(), userId: v.string(), computerId: v.string() }),
                await response.json(),
            );
        };
        return {
            baseConfiguration,
            network,
            executionNetwork,
            connectAgent: relay.connectAgent,
            relayRequest: relay.app.request,
            createAnonymousUser,
            dispatchFetch: cloudflare.dispatchFetch.bind(cloudflare),
            environment,
            origin: ready.origin,
            changeAppOrigin: async (origin: string) => {
                baseConfiguration.APP_ORIGIN = origin;
                await reconfigure();
            },
            changeRelayCredential: async (credential: string) => {
                baseConfiguration.MORTY_SERVICE_SECRET = credential;
                await reconfigure();
            },
            changeRelayOrigin: async (origin: string) => {
                baseConfiguration.MORTY_RELAY_URL = origin;
                await reconfigure();
            },
            close: async () => {
                await executionNetwork?.close();
                await network?.close();
                await chatNetwork?.close();
                await relay.close();
            },
        };
    } catch (cause) {
        await executionNetwork?.close();
        await network?.close();
        await chatNetwork?.close();
        await relay.close();
        throw cause;
    }
}
