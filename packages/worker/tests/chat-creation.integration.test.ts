import { fileURLToPath } from "node:url";
import { MortyClient, MortyPageRequest } from "@morty-build/client";
import * as v from "valibot";
import { afterEach, test as baseTest, beforeEach, expect, vi } from "vitest";
import type { ControlledAgent } from "../../../tests/support/fake-daemon/runtime.ts";
import worker, { fetchPublicApplication } from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

const targetSchema = v.object({ harness: v.string(), sessionId: v.string() });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

const test = baseTest.extend<{ readonly cloud: Awaited<ReturnType<typeof createIdentityFixture>> }>({
    cloud: [
        // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures declare their dependencies by destructuring.
        async ({}, use) => {
            const cloud = await createIdentityFixture({
                // Requests reach the Relay through a real proxy that can lose an answer the Relay sent.
                loseTurnResponses: true,
                workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
            });
            try {
                await use(cloud);
            } finally {
                await cloud.close();
            }
        },
        { scope: "file" },
    ],
});

test.beforeAll(async ({ cloud }) => {
    void cloud;
}, 30_000);

async function createChatFixture(
    cloud: Awaited<ReturnType<typeof createIdentityFixture>>,
    agents: readonly ControlledAgent[] = [{ id: "codex", label: "Codex" }],
    sessionIds: ReadonlySet<string> = new Set(),
) {
    const identity = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(identity.computerId, agents, sessionIds);
    const environment = cloud.environment();
    const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/morty/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/computers/${identity.computerId}/`) : `computers/${identity.computerId}/${path}`}`,
                {
                    method,
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "content-type": "application/json",
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                },
            ),
            environment,
        );
    const served = await request("management/bot");
    const { botId } = v.parse(v.object({ botId: v.string() }), await served.json());
    return {
        botId,
        computerId: identity.computerId,
        request,
        runtime,
        [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
    };
}

test("Given an owned Machine, When its owner requests access to an unmanaged session, Then Chat refuses to mint a credential while managed sessions remain usable", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    const unowned = await fixture.request(`chat/bots/${fixture.botId}/session-access`, {
        harness: "codex",
        sessionId: "chat_unowned_security_audit",
    });
    expect(unowned.status).toBe(404);
    expect(await unowned.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "security-audit-owned",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    const access = await fixture.request(`chat/bots/${fixture.botId}/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
        target: { harness: "codex", sessionId: sessionId },
        credential: expect.stringMatching(/^msession_/u),
    });

    // A Machine identifier that is not the caller's own opens nothing, even for a Session the caller owns.
    const otherMachine = await fixture.request(`chat/bots/bot_${crypto.randomUUID()}/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(otherMachine.status).toBe(404);

    const otherHarness = await fixture.request(`chat/bots/${fixture.botId}/session-access`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(otherHarness.status).toBe(404);
    expect(await otherHarness.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "unconfirmed" });
    const retained = await fixture.request(`chat/bots/${fixture.botId}/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(retained.status).toBe(200);
});

test("Given a draft Bot, When its owner sends the first message's creation request, Then the harness supplies the real session identity on the configured Runtime", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { computerId: fixture.runtime.computerId, agentRef: "codex" };
    const setupRuntimesResponse = await fixture.request(`chat/bots/${fixture.botId}/setup/runtimes`, {});
    expect(setupRuntimesResponse.status).toBe(200);
    const setupRuntimes = v.parse(
        v.strictObject({
            runtimes: v.array(
                v.strictObject({
                    computerId: v.string(),
                    machineName: v.string(),
                    online: v.boolean(),
                    agents: v.array(v.strictObject({ agentRef: v.string(), label: v.string() })),
                }),
            ),
        }),
        await setupRuntimesResponse.json(),
    );
    expect(setupRuntimes).toMatchObject({
        runtimes: [{ computerId: fixture.runtime.computerId, online: true, agents: [{ agentRef: "codex" }] }],
    });
    const draftRuntimeConfiguration = await fixture.request(`chat/bots/${fixture.botId}/workspace`, {});
    expect(draftRuntimeConfiguration.status).toBe(409);
    expect(await draftRuntimeConfiguration.json()).toMatchObject({ error: { code: "AGENT_REQUIRED" } });
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);

    const runtimeConfigurationResponse = await fixture.request(`chat/bots/${fixture.botId}/workspace`, {});
    expect(runtimeConfigurationResponse.status).toBe(200);
    expect(await runtimeConfigurationResponse.json()).toMatchObject({
        runtime: { computerId: fixture.runtime.computerId, online: true, agents: [{ agentRef: "codex" }] },
    });
    const configuredSetupRuntimes = await fixture.request(`chat/bots/${fixture.botId}/setup/runtimes`, {});
    expect(configuredSetupRuntimes.status).toBe(200);
    expect(await configuredSetupRuntimes.json()).toMatchObject({ runtimes: [{ computerId: fixture.computerId }] });

    const rebound = await fixture.request(`chat/bots/${fixture.botId}/setup`, {
        ...setup,
        computerId: "another-runtime",
    });
    expect(rebound.status).toBe(409);
    expect(await rebound.json()).toMatchObject({ error: { code: "BOT_RUNTIME_FIXED" } });

    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/agent-settings`, {
                agentRef: setup.agentRef,
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/workspace/directory`, {
                directoryId: "default",
            })
        ).status,
    ).toBe(200);

    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: setup.agentRef,
        configurations: [],
        conversationKey: "first-draft",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ target: targetSchema, credential: v.string(), ready: v.unknown() }),
        await opened.json(),
    );
    expect(access.target.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(access.credential).toMatch(/^msession_/u);

    const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(listed.status).toBe(200);
    const sessions = v.parse(
        v.object({
            sessions: v.array(
                v.object({
                    createdAt: v.pipe(v.string(), v.isoTimestamp()),
                    target: targetSchema,
                    status: v.object({ kind: v.string() }),
                    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
                }),
            ),
        }),
        await listed.json(),
    );
    expect(sessions).toMatchObject({
        sessions: [
            {
                target: access.target,
                status: { kind: "idle" },
                updatedAt: AUTH_TIME.toISOString(),
            },
        ],
    });
});

for (const { reason, ...configuration } of [
    { reason: "missing", configId: "removed-setting", valueType: "select", value: "default", booleanValue: false },
    { reason: "changed type", configId: "model", valueType: "boolean", value: "", booleanValue: true },
    { reason: "removed value", configId: "model", valueType: "select", value: "removed-model", booleanValue: false },
]) {
    test(`Given a ${reason} Agent setting, When Chat creates a conversation, Then it reports a conflict and a corrected retry opens one fully configured session`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud, [{ id: "configuration-test", label: "Settings Agent" }]);
        const computerId = fixture.runtime.computerId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "configuration-test" }))
                .status,
        ).toBe(202);
        const input = {
            agentRef: "configuration-test",
            conversationKey: "configuration-retry",
            workspaceRef: "default",
        };
        const rejected = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            ...input,
            configurations: [configuration],
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
        expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toEqual({
            sessions: [],
        });

        const configurations = [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "fast", valueType: "boolean", value: "", booleanValue: true },
            { configId: "effort", valueType: "select", value: "high", booleanValue: false },
        ];
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, { ...input, configurations });
        expect(opened.status).toBe(200);
        const access = v.parse(
            v.object({ target: targetSchema, credential: v.string(), ready: v.unknown() }),
            await opened.json(),
        );
        expect(access.credential).toMatch(/^msession_/u);
        const expectedReady = {
            configOptions: expect.arrayContaining([
                expect.objectContaining({ id: "model", currentValue: "test-large" }),
                expect.objectContaining({ id: "fast", booleanValue: true }),
                expect.objectContaining({ id: "effort", currentValue: "high" }),
            ]),
        };
        expect(access.ready).toMatchObject(expectedReady);
        const retried = await fixture.request(`chat/bots/${fixture.botId}/access`, { ...input, configurations });
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ target: access.target, ready: expectedReady });
        expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toMatchObject({
            sessions: [{ target: access.target }],
        });
    });
}

test("Given the answer to a new conversation's Session creation is lost, When the Runtime restarts and its owner retries the start, Then the conversation is owned and listed once and the retry opens the created Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real response-loss proxy");
    }
    const input = { agentRef: "codex", conversationKey: "lost-creation", workspaceRef: "default", configurations: [] };
    const lost = cloud.network.interruptNextSessionCreation();
    const failed = await fixture.request(`chat/bots/${fixture.botId}/access`, input);
    expect(await lost).toBeLessThan(300);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema })) }),
            await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json(),
        ).sessions;
    const [owned, ...others] = await listed();
    expect(others).toEqual([]);
    expect(owned).toBeDefined();
    await fixture.runtime.disconnect();
    await fixture.runtime.reconnect();

    const retried = await fixture.request(`chat/bots/${fixture.botId}/access`, input);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ target: owned?.target });
    expect(await listed()).toEqual([expect.objectContaining({ target: owned?.target })]);
});

test("Given a completed creation operation, When its first-send settings are changed on retry, Then Chat refuses the reused operation and keeps the original native conversation", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    const input = {
        agentRef: "codex",
        conversationKey: "conflicting-creation",
        workspaceRef: "default",
        configurations: [],
    };
    const first = await fixture.request(`chat/bots/${fixture.botId}/access`, input);
    expect(first.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await first.json());
    const refused = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        ...input,
        configurations: [{ configId: "model", valueType: "select", value: "test-large", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await listed.json()).toMatchObject({ sessions: [{ target }] });
});

test("Given a new conversation whose Session creation never reached the Runtime, When its owner lists conversations, Then none is listed until a retry creates it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real request-loss proxy");
    }
    const input = {
        agentRef: "codex",
        conversationKey: "dropped-creation",
        workspaceRef: "default",
        configurations: [],
    };
    cloud.network.dropNextSessionCreation();
    const failed = await fixture.request(`chat/bots/${fixture.botId}/access`, input);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema, title: v.string() })) }),
            await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json(),
        ).sessions;
    expect(await listed()).toEqual([]);

    const retried = await fixture.request(`chat/bots/${fixture.botId}/access`, input);
    expect(retried.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await retried.json());
    expect(await listed()).toEqual([expect.objectContaining({ target })]);
});

test("Given an Agent whose model decides its effort levels, When Chat starts a conversation that lists the effort before the model, Then the new Session holds both selections", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [{ id: "dependent-settings-test", label: "Settings Agent" }]);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "dependent-settings-test",
            })
        ).status,
    ).toBe(202);
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "dependent-settings-test",
        conversationKey: "effort-before-model",
        workspaceRef: "default",
        configurations: [
            { configId: "effort", valueType: "select", value: "low", booleanValue: false },
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
        ],
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
        ready: {
            configOptions: expect.arrayContaining([
                expect.objectContaining({ id: "model", currentValue: "test-large" }),
                expect.objectContaining({ id: "effort", currentValue: "low" }),
            ]),
        },
    });
});

test("Given dependent Agent settings, When applying a later selection changes an earlier one, Then Chat rejects creation instead of returning partially configured access", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [{ id: "dependent-settings-test", label: "Settings Agent" }]);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "dependent-settings-test",
            })
        ).status,
    ).toBe(202);
    const response = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "dependent-settings-test",
        conversationKey: "dependent-settings",
        workspaceRef: "default",
        configurations: [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "mode", valueType: "select", value: "plan", booleanValue: false },
        ],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
    expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toEqual({
        sessions: [],
    });
});

for (const configured of [false, true]) {
    test(`Given a Bot ${configured ? "bound to another Runtime" : "without a Runtime"}, When its owner browses or opens native sessions using a client-selected Runtime, Then Chat rejects every operation without creating sessions or ownership records`, async ({
        cloud,
    }) => {
        const sessionId = crypto.randomUUID();
        await using fixture = await createChatFixture(cloud, undefined, new Set([sessionId]));
        await using bound = configured ? await createChatFixture(cloud) : null;
        const owner = bound ?? fixture;
        if (bound !== null) {
            expect(
                (
                    await owner.request(`chat/bots/${owner.botId}/setup`, {
                        computerId: bound.runtime.computerId,
                        agentRef: "codex",
                    })
                ).status,
            ).toBe(202);
        }
        const computerId = fixture.runtime.computerId;
        const identity = { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
        // Obtain a valid discovery on the other Runtime through its public Platform API, so rejection cannot be
        // attributed to a nonexistent Runtime, entry, or discovery.
        const found = await fixture.runtime.client.runtimes.findNativeSessionBySessionId(
            { ...identity, sessionId },
            AbortSignal.timeout(10_000),
        );
        const before = await fixture.runtime.client.runtimes.listSessions(100, AbortSignal.timeout(10_000));
        const entry = { ...identity, computerId, directoryId: found.entry.directoryId };
        const paths = [
            { path: "native-sessions", input: { ...entry, action: "list", cursor: null, discoveryId: null } },
            { path: `native-session/${found.entry.entryId}`, input: { ...entry, sessionId } },
            {
                path: `native-session/${found.entry.entryId}/import`,
                input: { ...entry, discoveryId: found.discoveryId },
            },
            { path: "native-session-forks/fork-operation", input: { ...entry, sessionId } },
        ];
        const responses = [];
        for (const { path, input } of paths) {
            const response = await owner.request(`chat/bots/${owner.botId}/${path}`, input);
            responses.push({ path, status: response.status, body: await response.json() });
        }
        expect.soft(responses).toMatchObject(
            paths.map(({ path }) => ({
                path,
                status: 409,
                body: { error: { code: configured ? "BOT_RUNTIME_FIXED" : "AGENT_REQUIRED" } },
            })),
        );
        expect
            .soft(await fixture.runtime.client.runtimes.listSessions(100, AbortSignal.timeout(10_000)))
            .toEqual(before);
        if (!configured) {
            expect(
                (await owner.request(`chat/bots/${owner.botId}/setup`, { computerId, agentRef: "codex" })).status,
            ).toBe(202);
        }
        const managed = await owner.request(`chat/bots/${owner.botId}/managed-sessions`, {});
        expect(managed.status).toBe(200);
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { id: "codex", label: "Codex" },
        { id: "pi", label: "Pi" },
    ]);
    const setup = { computerId: fixture.runtime.computerId, agentRef: "codex" };
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);

    const unavailable = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "claude-code",
        configurations: [],
        conversationKey: "unavailable-agent",
        workspaceRef: "default",
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "AGENT_UNAVAILABLE" } });

    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "pi",
        configurations: [],
        conversationKey: "agent-mismatch",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(v.object({ agentRef: v.string(), target: targetSchema }), await opened.json());
    expect(access.agentRef).toBe("pi");

    const restored = await fixture.request(`chat/bots/${fixture.botId}/managed-session`, {
        harness: "pi",
        sessionId: access.target.sessionId,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ agentRef: "pi" });
});

test("Given an imported native session, When its owner imports it again, Then Chat reopens the canonical session without creating a duplicate", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "codex" })).status).toBe(
        202,
    );
    const identity = { computerId, agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
    const listed = await fixture.request(`chat/bots/${fixture.botId}/native-sessions`, {
        ...identity,
        action: "list",
        cursor: null,
        discoveryId: null,
    });
    expect(listed.status).toBe(200);
    const discovery = v.parse(
        v.object({
            discoveryId: v.string(),
            entries: v.array(v.object({ directoryId: v.string(), entryId: v.string() })),
        }),
        await listed.json(),
    );
    const entry = v.parse(v.object({ directoryId: v.string(), entryId: v.string() }), discovery.entries[0]);
    const entryId = entry.entryId;
    const path = `chat/bots/${fixture.botId}/native-session/${entryId}/import`;
    const input = { ...identity, directoryId: entry.directoryId, discoveryId: discovery.discoveryId };
    const first = await fixture.request(path, input);
    expect(first.status).toBe(200);
    const opened = v.parse(v.object({ ready: v.object({ target: targetSchema }) }), await first.json());
    const second = await fixture.request(path, input);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ready: { target: opened.ready.target } });
    const handoff = await fixture.request(`chat/bots/${fixture.botId}/continue-native-session`, {
        harness: "codex",
        sessionId: nativeId,
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ result: { ready: { target: opened.ready.target } } });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toMatchObject({ sessions: [{ target: opened.ready.target }] });
});

test("Given a managed Chat session is still running, When its owner archives it, Then Chat stops the Agent process and removes the session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "busy-archive",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    await fixture.runtime.client.turns.submitToRuntime(
        { harness: "codex", sessionId: sessionId },
        {
            additionalDirectoryIds: [],
            agentId: "codex",
            content: "wait for steering",
            directoryId: "default",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
});

test("Given an idle managed Chat session, When its owner archives it, Then Chat rejects reopening its old conversation ID even though Runtime history remains", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "idle-archive",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;

    const reopened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ target: { harness: "codex", sessionId: sessionId } });

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const rejected = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({
        error: {
            code: "NOT_FOUND",
            message:
                'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
        },
    });
    await expect(
        fixture.runtime.client.sessions.restore(
            { harness: "codex", sessionId: sessionId },
            AbortSignal.timeout(10_000),
        ),
    ).resolves.toMatchObject({ ready: { target: { harness: "codex", sessionId: sessionId } } });
});

for (const operation of ["access", "managed-session"]) {
    test(`Given a managed Chat session, When ${operation} and archival run concurrently, Then the archived session stays closed and cannot be reopened through Morty`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud);
        const computerId = fixture.runtime.computerId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "codex" })).status,
        ).toBe(202);
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "codex",
            configurations: [],
            conversationKey: "concurrent-archive",
            workspaceRef: "default",
        });
        const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;

        const [reopened, archived] = await Promise.all([
            fixture.request(`chat/bots/${fixture.botId}/${operation}`, {
                harness: "codex",
                sessionId: sessionId,
            }),
            fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
                harness: "codex",
                sessionId: sessionId,
            }),
        ]);

        expect([200, 404]).toContain(reopened.status);
        expect(archived.status).toBe(200);
        expect(await archived.json()).toEqual({ close: "confirmed" });
        await expect(
            fixture.runtime.client.sessions.rename(
                computerId,
                { harness: "codex", sessionId: sessionId },
                "Still closed",
                AbortSignal.timeout(10_000),
            ),
        ).rejects.toMatchObject({ code: "session_closed" });
        const rejected = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            harness: "codex",
            sessionId: sessionId,
        });
        expect(rejected.status).toBe(404);
        const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Runtime cannot complete Session close, When its owner archives a managed Chat session, Then Chat reports the unconfirmed close and still archives it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { computerId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "unavailable-close-archive",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    await fixture.runtime[Symbol.asyncDispose]();

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "unconfirmed" });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const repeated = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ close: "unconfirmed" });
});

test("Given a chat opened with a Session credential, When the machine's owner revokes all access, Then the Platform refuses that credential at once", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "revoked-while-open",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ endpoint: v.string(), computerId: v.string(), target: targetSchema, credential: v.string() }),
        await opened.json(),
    );
    const client = new MortyClient({
        endpoint: access.endpoint,
        computerId: access.computerId,
        credentialProvider: { credential: async () => access.credential },
    });
    const readHistory = () =>
        client.events.list(access.target, new MortyPageRequest(1, ""), AbortSignal.timeout(15_000));
    await readHistory();

    const revoked = await fixture.request("identity/revoke-all-access", {
        successor: `morty_anon_v1_${"A".repeat(43)}`,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ status: "access_revoked", sessionAccess: "revoked" });

    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
});

test("Given a browser following its chats' statuses, When the machine's owner revokes all access, Then the status stream ends without sending later statuses", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    const shared = await fixture.request("identity/transfers", {});
    const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        cloud.environment(),
    );
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "followed-while-revoked",
        workspaceRef: "default",
    });
    const { target } = v.parse(v.object({ target: targetSchema }), await opened.json());
    const upgraded = await cloud.dispatchFetch(`${APP_ORIGIN}/morty/ws`, {
        headers: { Origin: APP_ORIGIN, Upgrade: "websocket" },
    });
    const bridge = upgraded.webSocket;
    if (bridge === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    const frames: unknown[] = [];
    let arrived = (): void => {};
    bridge.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
        arrived();
    });
    const nextFrame = async () => {
        while (frames.length === 0) {
            await new Promise<void>((resolve) => {
                arrived = resolve;
            });
        }
        return frames.shift();
    };
    bridge.accept();
    bridge.send(
        JSON.stringify({
            kind: "subscribe",
            subscriptionId: "statuses",
            method: "POST",
            path: `/morty/api/chat/computers/${fixture.computerId}/bots/${fixture.botId}/managed-session/status-events`,
            headers: [["authorization", `Bearer ${browser}`]],
            body: null,
        }),
    );
    expect(await nextFrame()).toMatchObject({ kind: "event", subscriptionId: "statuses" });

    expect(
        (await fixture.request("identity/revoke-all-access", { successor: `morty_anon_v1_${"A".repeat(43)}` })).status,
    ).toBe(200);
    await fixture.runtime.client.turns.submitToRuntime(
        target,
        {
            additionalDirectoryIds: [],
            agentId: "codex",
            content: "Reply after revoke",
            directoryId: "default",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    expect(await nextFrame()).toEqual({ kind: "subscription.end", subscriptionId: "statuses" });
    bridge.close(1000, "Test complete");
});

test("Given two browsers joined through links, When one disconnects the other browsers, Then only it and the machine keep access and the other's open chat window is refused", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "codex",
            })
        ).status,
    ).toBe(202);
    const share = async () => {
        const shared = await fixture.request("identity/transfers", {});
        return new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    };
    const redeem = async (code: string) =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            cloud.environment(),
        );
    const join = async () => v.parse(v.object({ token: v.string() }), await (await redeem(await share())).json()).token;
    const owner = await join();
    const other = await join();
    const unused = await share();
    // The Web application reaches chat routes through its WebSocket bridge and identity routes over public HTTP.
    const asBrowser = (token: string, path: string, method = "GET", body?: object) =>
        (path.startsWith("chat/") ? worker.fetch : fetchPublicApplication)(
            new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            cloud.environment(),
        );
    const opened = await asBrowser(other, `chat/computers/${fixture.computerId}/bots/${fixture.botId}/access`, "POST", {
        agentRef: "codex",
        configurations: [],
        conversationKey: "other-browser-window",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const window = v.parse(
        v.object({ endpoint: v.string(), computerId: v.string(), target: targetSchema, credential: v.string() }),
        await opened.json(),
    );
    const readHistory = () =>
        new MortyClient({
            endpoint: window.endpoint,
            computerId: window.computerId,
            credentialProvider: { credential: async () => window.credential },
        }).events.list(window.target, new MortyPageRequest(1, ""), AbortSignal.timeout(15_000));
    await readHistory();

    const ended = await asBrowser(owner, `computers/${fixture.computerId}/identity/v1/other-browser-access`, "DELETE");

    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ status: "other_browser_access_ended", sessionAccess: "revoked" });
    expect((await asBrowser(owner, `computers/${fixture.computerId}/session`)).status).toBe(200);
    expect((await fixture.request("session")).status).toBe(200);
    const refused = await asBrowser(other, `computers/${fixture.computerId}/session`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { reason: "ACCESS_REVOKED" } });
    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
    expect((await redeem(unused)).status).toBe(410);
});

test("Given a browser connecting from a city, When it opens a link through the bridge, Then the device list shows roughly where it joined, never what the browser claimed", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const shared = await fixture.request("identity/transfers", {});
    const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    const upgraded = await cloud.dispatchFetch(`${APP_ORIGIN}/morty/ws`, {
        headers: {
            Origin: APP_ORIGIN,
            Upgrade: "websocket",
            // A browser cannot name its own location: the Worker replaces this with Cloudflare's.
            "Morty-Client-Location": encodeURIComponent(JSON.stringify({ city: "Elsewhere", country: "AQ" })),
        },
        cf: { city: "Shanghai", country: "CN" },
    });
    const bridge = upgraded.webSocket;
    if (bridge === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    bridge.accept();
    const reply = new Promise<unknown>((resolve) => {
        bridge.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
    });
    bridge.send(
        JSON.stringify({
            kind: "request",
            requestId: "redeem",
            method: "POST",
            path: "/morty/api/identity/transfers/redeem",
            headers: [["content-type", "application/json"]],
            body: JSON.stringify({ code, device: "iPhone · Safari" }),
        }),
    );
    expect(await reply).toMatchObject({ kind: "response", status: 200 });
    bridge.close();

    const listed = v.parse(
        v.object({ devices: v.array(v.object({ label: v.nullable(v.string()), location: v.unknown() })) }),
        await (await fixture.request("identity/devices")).json(),
    );
    expect(listed.devices).toEqual([{ label: "iPhone · Safari", location: { city: "Shanghai", country: "CN" } }]);
});

test("Given an existing owned conversation, When a repeated start is refused, Then ownership remains", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [{ id: "configuration-test", label: "Settings Agent" }]);
    expect(
        (
            await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                computerId: fixture.runtime.computerId,
                agentRef: "configuration-test",
            })
        ).status,
    ).toBe(202);
    const input = { agentRef: "configuration-test", conversationKey: "audit-retry", workspaceRef: "default" };
    const started = await fixture.request(`chat/bots/${fixture.botId}/access`, { ...input, configurations: [] });
    expect(started.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await started.json());
    expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toMatchObject({
        sessions: [{ target }],
    });
    const repeated = await fixture.request(`chat/bots/${fixture.botId}/access`, { ...input, configurations: [] });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ target });
    const refused = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        ...input,
        configurations: [{ configId: "removed-setting", valueType: "select", value: "default", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const access = await fixture.request(`chat/bots/${fixture.botId}/session-access`, {
        harness: "configuration-test",
        sessionId: target.sessionId,
    });
    const listed = await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json();
    expect(access.status).toBe(200);
    expect(listed).toMatchObject({ sessions: [{ target }] });
});
