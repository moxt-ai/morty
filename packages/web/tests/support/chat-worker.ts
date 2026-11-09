import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
import { WebSocketApiTransport } from "../../src/services/api/websocket-api-transport.ts";
import type { Clock } from "../../src/services/time/clock.ts";

/**
 * The budget of a scenario that starts its own Chat and Platform Workers. Starting them costs seconds on a busy
 * runner, on top of the waits the shared test budget already covers, so these scenarios get room for both.
 */
export const dedicatedEnvironmentTimeout = 60_000;

export async function createChatWorkerEnvironment(loseTurnResponses = false, delayExecutionReads = false) {
    const cloud = await createIdentityFixture({
        listenOnLoopback: true,
        ...(loseTurnResponses ? { loseTurnResponses: true as const } : {}),
        ...(delayExecutionReads ? { delayExecutionReads: true as const } : {}),
        platformAllowedOrigins: new Set(["*"]),
        workerEntryPoint: resolve(process.cwd(), "../worker/tests/support/credential-storage-worker.ts"),
        wranglerConfiguration: pathToFileURL(resolve(process.cwd(), "../../wrangler.jsonc")),
    });
    const origin = cloud.origin;
    const createApplication = async (clock?: Clock) => {
        const identityResponse = await cloud.dispatchFetch(`${origin}/morty/api/identity/anonymous-users`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
        });
        if (identityResponse.status !== 201) {
            throw new Error(`Could not create an anonymous Morty identity: ${identityResponse.status}`);
        }
        const identity = v.parse(
            v.object({
                token: v.string(),
                userId: v.string(),
                computerId: v.string(),
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
        const transport = new WebSocketApiTransport(origin, clock);
        transport.open();
        const connect = async (agents: readonly ControlledAgent[], nativeSessionIds?: ReadonlySet<string>) => {
            const runtime = await cloud.connectAgent(identity.computerId, agents, nativeSessionIds);
            const setup = await request(`chat/computers/${identity.computerId}/bots/${botId}/setup`, {
                computerId: runtime.computerId,
                agentRef: agents[0]?.id ?? "codex",
            });
            if (setup.status !== 202) {
                throw new Error(`Could not prepare the test Runtime: ${setup.status} ${await setup.text()}`);
            }
            return {
                failure: runtime.failure,
                continueReply: runtime.continueReply,
                /** Closes a Session through the Platform, the way another Morty client of this Runtime would. */
                closeSession: async (sessionId: string): Promise<void> => {
                    await runtime.client.sessions.close(sessionId, new AbortController().signal);
                },
                /** Applies another client's explicit model edit through the public Platform contract. */
                selectModel: async (sessionId: string, value: string): Promise<void> => {
                    const signal = AbortSignal.timeout(30_000);
                    const snapshot = await runtime.client.sessions.readConfiguration(
                        runtime.computerId,
                        sessionId,
                        signal,
                    );
                    await runtime.client.sessions.updateConfiguration(
                        runtime.computerId,
                        sessionId,
                        {
                            agentId: agents[0]?.id ?? "codex",
                            booleanValue: false,
                            configId: "model",
                            directoryId: "default",
                            expectedConfigurationRevision: snapshot.configurationRevision,
                            value,
                            valueType: "select",
                        },
                        signal,
                    );
                },
                /** Starts a turn through the Platform, the way another Morty client of this Runtime would. */
                submitTurn: async (sessionId: string, content: string): Promise<void> => {
                    await runtime.client.turns.submitToRuntime(
                        sessionId,
                        {
                            agentId: agents[0]?.id ?? "codex",
                            attachments: [],
                            content,
                            directoryId: "default",
                            idempotencyKey: crypto.randomUUID(),
                        },
                        AbortSignal.timeout(30_000),
                    );
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
                /** Renames a Session through the Platform, the way another Morty client of this Runtime would. */
                renameSession: async (sessionId: string, title: string): Promise<void> => {
                    await runtime.client.sessions.rename(
                        runtime.computerId,
                        sessionId,
                        title,
                        new AbortController().signal,
                    );
                },
                disconnect: runtime.disconnect,
                reconnect: runtime.reconnect,
                /** Revokes the Runtime through the Platform, as the Relay does when its credential was reused. */
                revoke: async (): Promise<void> => {
                    const response = await cloud.platformRequest(
                        new Request(`https://platform.test/morty/api/v1/computers/${identity.computerId}/pairing`, {
                            method: "DELETE",
                            headers: { authorization: `Bearer ${cloud.baseConfiguration.MORTY_SERVICE_SECRET}` },
                        }),
                    );
                    if (response.status !== 204) {
                        throw new Error(`Could not revoke the test Runtime: ${response.status}`);
                    }
                },
                writeFiles: runtime.writeFiles,
            };
        };
        return {
            botId,
            network: cloud.network,
            executionNetwork: cloud.executionNetwork,
            connectAgent: async (
                agent: ControlledAgent = { id: "claude", label: "Codex" },
                nativeSessionIds?: ReadonlySet<string>,
            ) => await connect([agent], nativeSessionIds),
            connectAgents: async (agents: readonly ControlledAgent[], nativeSessionIds?: ReadonlySet<string>) =>
                await connect(agents, nativeSessionIds),
            connectRuntime: async () => {
                const runtime = await cloud.connectAgent(identity.computerId);
                return { failure: runtime.failure, computerId: runtime.computerId };
            },
            createTransferUrl: async () => {
                const response = await request(`computers/${identity.computerId}/identity/transfers`, {});
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
                computerId: identity.computerId,
            },
            origin,
            transport,
            userId: identity.userId,
            close: () => transport.dispose(),
        };
    };
    return {
        createApplication,
        close: cloud.close,
    };
}
