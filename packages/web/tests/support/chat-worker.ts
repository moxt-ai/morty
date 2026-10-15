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
            throw new Error(`Could not create an anonymous Morty identity: ${identityResponse.status}`);
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
            connectAgent: async (
                agent: { readonly id: string; readonly label: string } = { id: "claude", label: "Codex" },
                nativeSessionIds?: ReadonlySet<string>,
                pairingInstruction?: string,
            ) => {
                let targetBotId = botId;
                if (pairingInstruction !== undefined) {
                    const pairingUrl = pairingInstruction.match(/https?:\/\/\S+/u)?.[0];
                    if (pairingUrl === undefined) {
                        throw new Error("The agent instruction does not contain a pairing URL.");
                    }
                    const url = new URL(pairingUrl);
                    const redeemed = await request("identity/pairings/redeem", {
                        token: url.searchParams.get("token"),
                    });
                    if (redeemed.status !== 200) {
                        throw new Error(`Could not redeem the agent instruction: ${redeemed.status}`);
                    }
                    targetBotId = v.parse(v.object({ botId: v.string() }), await redeemed.json()).botId;
                }
                const runtime = await cloud.connectAgent(identity.projectId, [agent], nativeSessionIds);
                const setup = await request(`chat/projects/${identity.projectId}/bots/${targetBotId}/setup`, {
                    runtimeId: runtime.runtimeId,
                    agentRef: agent.id,
                });
                if (setup.status !== 202) {
                    throw new Error(`Could not prepare the test Machine: ${setup.status} ${await setup.text()}`);
                }
                return {
                    failure: runtime.failure,
                    continueReply: runtime.continueReply,
                    disconnect: async () => await runtime[Symbol.asyncDispose](),
                };
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
