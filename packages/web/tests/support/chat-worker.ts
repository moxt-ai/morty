import { resolve } from "node:path";
import * as v from "valibot";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createResponseLossProxy } from "../../../relay-test-support/src/response-loss-proxy.ts";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
import { TestApiTransport } from "./test-api-transport.ts";

/**
 * The budget of a scenario that starts its own Chat and Relay Workers. Starting them costs seconds on a busy
 * runner, on top of the waits the shared test budget already covers, so these scenarios get room for both.
 */
export const dedicatedEnvironmentTimeout = 60_000;

export async function createChatWorkerEnvironment(
    loseTurnResponses = false,
    delayExecutionReads = false,
    loseSharingResponses = false,
) {
    const cloud = await createIdentityFixture({
        listenOnLoopback: true,
        ...(loseTurnResponses ? { loseTurnResponses: true as const } : {}),
        ...(delayExecutionReads ? { delayExecutionReads: true as const } : {}),
        relayAllowedOrigins: new Set(["*"]),
        workerEntryPoint: resolve(process.cwd(), "../worker/tests/support/credential-storage-worker.ts"),
    });
    const sharingNetwork = loseSharingResponses ? await createResponseLossProxy(cloud.origin) : null;
    const origin = sharingNetwork?.origin ?? cloud.origin;
    if (sharingNetwork !== null) {
        await cloud.changeAppOrigin(origin);
    }
    const createApplication = async () => {
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
        const computerId = identity.computerId;
        const transport = new TestApiTransport(origin);
        transport.open();
        const connect = async (agents: readonly ControlledAgent[], sessionIds?: ReadonlySet<string>) => {
            const runtime = await cloud.connectAgent(identity.computerId, agents, sessionIds);
            const setup = await request(`chat/computers/${identity.computerId}/setup`, {
                computerId: runtime.computerId,
                harness: agents[0]?.harness ?? "codex",
            });
            if (setup.status !== 202) {
                throw new Error(`Could not prepare the test Runtime: ${setup.status} ${await setup.text()}`);
            }
            return {
                failure: runtime.failure,
                continueReply: runtime.continueReply,
                /** Closes a Session through the Relay, the way another Morty client of this Runtime would. */
                closeSession: async (sessionId: string): Promise<void> => {
                    await runtime.client.sessions.close(
                        { harness: agents[0]?.harness ?? "codex", sessionId: sessionId },
                        new AbortController().signal,
                    );
                },
                /** Applies another client's explicit model edit through the public Relay contract. */
                selectModel: async (sessionId: string, value: string): Promise<void> => {
                    const signal = AbortSignal.timeout(30_000);
                    const snapshot = await runtime.client.sessions.readConfiguration(
                        runtime.computerId,
                        { harness: agents[0]?.harness ?? "codex", sessionId: sessionId },
                        signal,
                    );
                    await runtime.client.sessions.updateConfiguration(
                        runtime.computerId,
                        { harness: agents[0]?.harness ?? "codex", sessionId: sessionId },
                        {
                            booleanValue: false,
                            configId: "model",
                            expectedConfigurationRevision: snapshot.configurationRevision,
                            value,
                            valueType: "select",
                        },
                        signal,
                    );
                },
                /** Starts a turn through the Relay, the way another Morty client of this Runtime would. */
                submitTurn: async (sessionId: string, content: string): Promise<void> => {
                    await runtime.client.turns.submitToRuntime(
                        { harness: agents[0]?.harness ?? "codex", sessionId: sessionId },
                        {
                            attachments: [],
                            content,
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
                        additionalAgents: others.map((agent) => ({ harness: agent.harness, name: agent.label })),
                        harness: first.harness,
                        agentName: first.label,
                    });
                },
                /** Reads the current title through a separate client's production Runtime API. */
                readSessionTitle: async (sessionId: string) => {
                    const [session] = await runtime.client.runtimes.querySessions(
                        [{ harness: agents[0]?.harness ?? "codex", sessionId }],
                        AbortSignal.timeout(30_000),
                    );
                    if (session === undefined) {
                        throw new Error("Expected the Session on the Runtime");
                    }
                    return session.title;
                },
                /** Renames a Session through the Relay, the way another Morty client of this Runtime would. */
                renameSession: async (sessionId: string, title: string): Promise<void> => {
                    await runtime.client.sessions.rename(
                        runtime.computerId,
                        { harness: agents[0]?.harness ?? "codex", sessionId: sessionId },
                        title,
                        new AbortController().signal,
                    );
                },
                disconnect: runtime.disconnect,
                reconnect: runtime.reconnect,
                /** Revokes the Runtime through the Relay, as the Relay does when its credential was reused. */
                revoke: async (): Promise<void> => {
                    const response = await cloud.relayRequest(
                        new Request(`https://relay.test/morty/api/v1/computers/${identity.computerId}/pairing`, {
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
            computerId,
            network: cloud.network,
            sharingNetwork,
            executionNetwork: cloud.executionNetwork,
            connectAgent: async (
                agent: ControlledAgent = { harness: "claude", label: "Codex" },
                sessionIds?: ReadonlySet<string>,
            ) => await connect([agent], sessionIds),
            connectAgents: async (agents: readonly ControlledAgent[], sessionIds?: ReadonlySet<string>) =>
                await connect(agents, sessionIds),
            connectRuntime: async () => {
                const runtime = await cloud.connectAgent(identity.computerId);
                return { failure: runtime.failure, computerId: runtime.computerId };
            },
            createTransferUrl: async () => {
                const response = await request(`computers/${identity.computerId}/identity/transfers`, {
                    operationId: crypto.randomUUID(),
                });
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
        close: async () => {
            try {
                await sharingNetwork?.close();
            } finally {
                await cloud.close();
            }
        },
    };
}
