import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
import { WebSocketApiTransport } from "../../src/services/api/websocket-api-transport.ts";
import { createChatNetwork } from "../infra/chat-network.ts";

export async function createChatWorkerEnvironment() {
    const cloud = await createIdentityFixture({
        listenOnLoopback: true,
        platformAllowedOrigins: new Set(["*"]),
        workerEntryPoint: resolve(process.cwd(), "../worker/src/index.ts"),
        wranglerConfiguration: pathToFileURL(resolve(process.cwd(), "../../wrangler.jsonc")),
    });
    const origin = cloud.origin;
    const createApplication = async (options: { readonly interruptibleChat?: boolean } = {}) => {
        const identityResponse = await cloud.dispatchFetch(`${origin}/morty/api/identity/anonymous-users`, {
            method: "POST",
        });
        if (identityResponse.status !== 201) {
            throw new Error(`Could not create an anonymous Morty identity: ${identityResponse.status}`);
        }
        const identity = v.parse(
            v.object({
                token: v.string(),
                userId: v.string(),
                projectId: v.string(),
                bot: v.object({ botId: v.string() }),
            }),
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
        const botId = identity.bot.botId;
        const chatNetwork = options.interruptibleChat === true ? await createChatNetwork(origin) : null;
        const browserOrigin = chatNetwork?.origin ?? origin;
        const transport = new WebSocketApiTransport(browserOrigin);
        transport.open();
        const connect = async (agents: readonly ControlledAgent[], nativeSessionIds?: ReadonlySet<string>) => {
            const runtime = await cloud.connectAgent(identity.projectId, agents, nativeSessionIds);
            const setup = await request(`chat/projects/${identity.projectId}/bots/${botId}/setup`, {
                runtimeId: runtime.runtimeId,
                agentRef: agents[0]?.id ?? "codex",
            });
            if (setup.status !== 202) {
                throw new Error(`Could not prepare the test Runtime: ${setup.status} ${await setup.text()}`);
            }
            return {
                failure: runtime.failure,
                continueReply: runtime.continueReply,
                /** Closes a Session through the Platform, the way another Mobius client of this Runtime would. */
                closeSession: async (sessionId: string): Promise<void> => {
                    await runtime.client.sessions.close(runtime.runtimeId, sessionId, new AbortController().signal);
                },
                /** Restarts the Runtime offering these Agents, as when the user installs or removes one. */
                replaceAgents: async (replacement: readonly ControlledAgent[]): Promise<void> => {
                    const [first, ...others] = replacement;
                    if (first === undefined) {
                        throw new Error("A controlled Runtime needs at least one Agent");
                    }
                    await runtime.restartWithAgents({
                        additionalAgents: others.map((agent) => ({ id: agent.id, name: agent.label })),
                        agentId: first.id,
                        agentName: first.label,
                    });
                },
                /** Renames a Session through the Platform, the way another Mobius client of this Runtime would. */
                renameSession: async (sessionId: string, title: string): Promise<void> => {
                    await runtime.client.sessions.rename(
                        runtime.runtimeId,
                        sessionId,
                        title,
                        new AbortController().signal,
                    );
                },
                disconnect: runtime.disconnect,
                reconnect: runtime.reconnect,
                writeFiles: runtime.writeFiles,
            };
        };
        return {
            botId,
            connectAgent: async (
                agent: ControlledAgent = { id: "claude", label: "Codex" },
                nativeSessionIds?: ReadonlySet<string>,
            ) => await connect([agent], nativeSessionIds),
            connectAgents: async (agents: readonly ControlledAgent[], nativeSessionIds?: ReadonlySet<string>) =>
                await connect(agents, nativeSessionIds),
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
                botId,
                getToken: async (signal: AbortSignal): Promise<string> => {
                    signal.throwIfAborted();
                    return identity.token;
                },
                projectId: identity.projectId,
            },
            origin: browserOrigin,
            chatNetwork,
            transport,
            userId: identity.userId,
            close: async () => {
                transport.close();
                await chatNetwork?.close();
            },
        };
    };
    return {
        createApplication,
        close: cloud.close,
    };
}
