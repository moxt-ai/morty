import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
import { WebSocketApiTransport } from "../../src/services/api/websocket-api-transport.ts";

async function availableOrigin(): Promise<string> {
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

export async function createChatWorkerEnvironment() {
    const origin = await availableOrigin();
    const cloud = await createIdentityFixture({
        appOrigin: origin,
        platformAllowedOrigins: new Set(["*"]),
        workerEntryPoint: resolve(process.cwd(), "../worker/src/index.ts"),
        wranglerConfiguration: pathToFileURL(resolve(process.cwd(), "../../wrangler.jsonc")),
    });
    const createApplication = async () => {
        const identityResponse = await cloud.dispatchFetch(`${origin}/morty/api/identity/anonymous-users`, {
            method: "POST",
        });
        if (identityResponse.status !== 201) {
            throw new Error(`Could not create an anonymous workspace: ${identityResponse.status}`);
        }
        const identity = v.parse(
            v.object({ token: v.string(), userId: v.string(), projectId: v.string() }),
            await identityResponse.json(),
        );
        const request = async (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            await cloud.dispatchFetch(`${origin}/morty/api/${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const bots = v.parse(
            v.object({ bots: v.array(v.object({ botId: v.string() })) }),
            await (await request(`projects/${identity.projectId}/management/bots`)).json(),
        );
        const botId = v.parse(v.string(), bots.bots[0]?.botId);
        const transport = new WebSocketApiTransport(origin);
        transport.open();
        return {
            botId,
            connectAgent: async () => {
                const runtime = await cloud.connectAgent(identity.projectId, [
                    { arguments: ["--load-only"], id: "claude", label: "Codex" },
                ]);
                const setup = await request(`chat/projects/${identity.projectId}/bots/${botId}/setup`, {
                    runtimeId: runtime.runtimeId,
                    agentRef: "claude",
                });
                if (setup.status !== 202) {
                    throw new Error(`Could not prepare the test Bot: ${setup.status} ${await setup.text()}`);
                }
                return { failure: runtime.failure };
            },
            connectRuntime: async () => {
                const runtime = await cloud.connectAgent(identity.projectId);
                return { failure: runtime.failure, runtimeId: runtime.runtimeId };
            },
            createTransferUrl: async () => {
                const response = await request(`projects/${identity.projectId}/identity/transfers`, {});
                if (response.status !== 201) {
                    throw new Error(`Could not create a transfer link: ${response.status} ${await response.text()}`);
                }
                return v.parse(v.object({ url: v.string() }), await response.json()).url;
            },
            identity: {
                getToken: async (signal: AbortSignal): Promise<string> => {
                    signal.throwIfAborted();
                    return identity.token;
                },
                kind: "anonymous" as const,
                projectId: identity.projectId,
            },
            origin,
            transport,
            userId: identity.userId,
            close: () => transport.close(),
        };
    };
    return {
        createApplication,
        close: cloud.close,
    };
}
