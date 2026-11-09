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
    agents: readonly ControlledAgent[] = [{ harness: "codex", label: "Codex" }],
    sessionIds: ReadonlySet<string> = new Set(),
) {
    const identity = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(identity.computerId, agents, sessionIds);
    const environment = cloud.environment();
    const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/morty/api/${path.startsWith("chat/computers/") ? path : path.startsWith("chat/") ? path.replace("chat/", `chat/computers/${identity.computerId}/`) : `computers/${identity.computerId}/${path}`}`,
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
    return {
        computerId: identity.computerId,
        request,
        runtime,
        [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
    };
}

test("Given an archived conversation, When the original creation request is retried, Then its receipt cannot restore the archived Session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect((await fixture.request("chat/setup", { computerId: fixture.computerId, harness: "codex" })).status).toBe(
        202,
    );
    const input = {
        harness: "codex",
        configurations: [],
        conversationKey: "archived-creation-retry",
        workspaceRef: ".",
    };
    const created = await fixture.request("chat/access", input);
    expect(created.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await created.json());
    const ordinaryRetry = await fixture.request("chat/access", input);
    expect(ordinaryRetry.status).toBe(200);
    expect(v.parse(v.object({ target: targetSchema }), await ordinaryRetry.json()).target).toEqual(target);
    expect((await fixture.request("chat/managed-session/archive", target)).status).toBe(200);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    const refusedBeforeReplay = await fixture.request("chat/access", target);
    expect(refusedBeforeReplay.status).toBe(404);
    expect(await refusedBeforeReplay.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const retried = await fixture.request("chat/access", input);
    expect(retried.status).toBe(200);
    expect(v.parse(v.object({ target: targetSchema }), await retried.json()).target).toEqual(target);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    expect((await fixture.request("chat/access", target)).status).toBe(404);
});

test("Given a paired computer, When its owner selects and creates with harness, Then setup and session access expose the same harness", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = await fixture.request("chat/setup", {
        computerId: fixture.computerId,
        harness: "codex",
    });
    expect(setup.status).toBe(202);
    const workspace = await fixture.request("chat/workspace", {});
    expect(await workspace.json()).toMatchObject({ runtime: { agents: [{ harness: "codex" }] } });
    const created = await fixture.request("chat/access", {
        harness: "codex",
        configurations: [],
        conversationKey: "unified-harness",
        workspaceRef: ".",
    });
    expect(created.status).toBe(200);
    const access = await created.json();
    expect(access).toMatchObject({ harness: "codex", target: { harness: "codex" } });
    expect(access).not.toHaveProperty("agentRef");
    expect(access).not.toHaveProperty("agentId");
    const { target } = v.parse(v.object({ target: targetSchema }), access);
    const restored = await fixture.request("chat/access", target);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ harness: "codex", target });
});

test("Given a computer addressed by its identity, When its owner requests access to an unmanaged session, Then Chat refuses to mint a credential while managed sessions remain usable", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    const unowned = await fixture.request(`chat/session-access`, {
        harness: "codex",
        sessionId: "chat_unowned_security_audit",
    });
    expect(unowned.status).toBe(404);
    expect(await unowned.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "security-audit-owned",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    const access = await fixture.request(`chat/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
        target: { harness: "codex", sessionId: sessionId },
        credential: expect.stringMatching(/^msession_/u),
    });

    // Another computer identity opens nothing with this credential, even for a Session the caller owns.
    const anotherComputer = await cloud.createAnonymousUser();
    const otherMachine = await fixture.request(`chat/computers/${anotherComputer.computerId}/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(otherMachine.status).toBe(401);
    expect(await otherMachine.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const otherHarness = await fixture.request(`chat/session-access`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(otherHarness.status).toBe(404);
    expect(await otherHarness.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const archived = await fixture.request(`chat/managed-session/archive`, {
        harness: "pi",
        sessionId: sessionId,
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "unconfirmed" });
    const retained = await fixture.request(`chat/session-access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(retained.status).toBe(200);
});

test("Given a draft Bot, When its owner sends the first message's creation request, Then the harness supplies the real session identity on the configured Runtime", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { computerId: fixture.runtime.computerId, harness: "codex" };
    const setupRuntimesResponse = await fixture.request(`chat/setup/runtimes`, {});
    expect(setupRuntimesResponse.status).toBe(200);
    const setupRuntimes = v.parse(
        v.strictObject({
            runtimes: v.array(
                v.strictObject({
                    computerId: v.string(),
                    machineName: v.string(),
                    online: v.boolean(),
                    agents: v.array(v.strictObject({ harness: v.string(), label: v.string() })),
                }),
            ),
        }),
        await setupRuntimesResponse.json(),
    );
    expect(setupRuntimes).toMatchObject({
        runtimes: [{ computerId: fixture.runtime.computerId, online: true, agents: [{ harness: "codex" }] }],
    });
    const draftRuntimeConfiguration = await fixture.request(`chat/workspace`, {});
    expect(draftRuntimeConfiguration.status).toBe(409);
    expect(await draftRuntimeConfiguration.json()).toMatchObject({ error: { code: "AGENT_REQUIRED" } });
    expect((await fixture.request(`chat/setup`, setup)).status).toBe(202);

    const runtimeConfigurationResponse = await fixture.request(`chat/workspace`, {});
    expect(runtimeConfigurationResponse.status).toBe(200);
    expect(await runtimeConfigurationResponse.json()).toMatchObject({
        runtime: { computerId: fixture.runtime.computerId, online: true, agents: [{ harness: "codex" }] },
    });
    const configuredSetupRuntimes = await fixture.request(`chat/setup/runtimes`, {});
    expect(configuredSetupRuntimes.status).toBe(200);
    expect(await configuredSetupRuntimes.json()).toMatchObject({ runtimes: [{ computerId: fixture.computerId }] });

    const rebound = await fixture.request(`chat/setup`, {
        ...setup,
        computerId: "another-runtime",
    });
    expect(rebound.status).toBe(409);
    expect(await rebound.json()).toMatchObject({ error: { code: "BOT_RUNTIME_FIXED" } });

    expect(
        (
            await fixture.request(`chat/agent-settings`, {
                harness: setup.harness,
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await fixture.request(`chat/workspace/directory`, {
                directory: ".",
            })
        ).status,
    ).toBe(200);

    const opened = await fixture.request(`chat/access`, {
        harness: setup.harness,
        configurations: [],
        conversationKey: "first-draft",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ target: targetSchema, credential: v.string(), ready: v.unknown() }),
        await opened.json(),
    );
    expect(access.target.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    expect(access.credential).toMatch(/^msession_/u);

    const listed = await fixture.request(`chat/managed-sessions`, {});
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
        await using fixture = await createChatFixture(cloud, [
            { harness: "configuration-test", label: "Settings Agent" },
        ]);
        const computerId = fixture.runtime.computerId;
        expect((await fixture.request(`chat/setup`, { computerId, harness: "configuration-test" })).status).toBe(202);
        const input = {
            harness: "configuration-test",
            conversationKey: "configuration-retry",
            workspaceRef: ".",
        };
        const rejected = await fixture.request(`chat/access`, {
            ...input,
            configurations: [configuration],
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
        expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({
            sessions: [],
        });

        const configurations = [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "fast", valueType: "boolean", value: "", booleanValue: true },
            { configId: "effort", valueType: "select", value: "high", booleanValue: false },
        ];
        const opened = await fixture.request(`chat/access`, { ...input, configurations });
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
        const retried = await fixture.request(`chat/access`, { ...input, configurations });
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ target: access.target, ready: expectedReady });
        expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
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
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real response-loss proxy");
    }
    const input = { harness: "codex", conversationKey: "lost-creation", workspaceRef: ".", configurations: [] };
    const lost = cloud.network.interruptNextSessionCreation();
    const failed = await fixture.request(`chat/access`, input);
    expect(await lost).toBeLessThan(300);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema })) }),
            await (await fixture.request(`chat/managed-sessions`, {})).json(),
        ).sessions;
    const [owned, ...others] = await listed();
    expect(others).toEqual([]);
    expect(owned).toBeDefined();
    await fixture.runtime.disconnect();
    await fixture.runtime.reconnect();

    const retried = await fixture.request(`chat/access`, input);
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
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    const input = {
        harness: "codex",
        conversationKey: "conflicting-creation",
        workspaceRef: ".",
        configurations: [],
    };
    const first = await fixture.request(`chat/access`, input);
    expect(first.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await first.json());
    const refused = await fixture.request(`chat/access`, {
        ...input,
        configurations: [{ configId: "model", valueType: "select", value: "test-large", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const listed = await fixture.request(`chat/managed-sessions`, {});
    expect(await listed.json()).toMatchObject({ sessions: [{ target }] });
});

test("Given a new conversation whose Session creation never reached the Runtime, When its owner lists conversations, Then none is listed until a retry creates it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    if (cloud.network === null) {
        throw new Error("The scenario requires a real request-loss proxy");
    }
    const input = {
        harness: "codex",
        conversationKey: "dropped-creation",
        workspaceRef: ".",
        configurations: [],
    };
    cloud.network.dropNextSessionCreation();
    const failed = await fixture.request(`chat/access`, input);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const listed = async () =>
        v.parse(
            v.object({ sessions: v.array(v.object({ target: targetSchema, title: v.string() })) }),
            await (await fixture.request(`chat/managed-sessions`, {})).json(),
        ).sessions;
    expect(await listed()).toEqual([]);

    const retried = await fixture.request(`chat/access`, input);
    expect(retried.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await retried.json());
    expect(await listed()).toEqual([expect.objectContaining({ target })]);
});

test("Given an Agent whose model decides its effort levels, When Chat starts a conversation that lists the effort before the model, Then the new Session holds both selections", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "dependent-settings-test", label: "Settings Agent" },
    ]);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "dependent-settings-test",
            })
        ).status,
    ).toBe(202);
    const opened = await fixture.request(`chat/access`, {
        harness: "dependent-settings-test",
        conversationKey: "effort-before-model",
        workspaceRef: ".",
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
    await using fixture = await createChatFixture(cloud, [
        { harness: "dependent-settings-test", label: "Settings Agent" },
    ]);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "dependent-settings-test",
            })
        ).status,
    ).toBe(202);
    const response = await fixture.request(`chat/access`, {
        harness: "dependent-settings-test",
        conversationKey: "dependent-settings",
        workspaceRef: ".",
        configurations: [
            { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
            { configId: "mode", valueType: "select", value: "plan", booleanValue: false },
        ],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "session_configuration_conflict" } });
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toEqual({
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
                    await owner.request(`chat/setup`, {
                        computerId: bound.runtime.computerId,
                        harness: "codex",
                    })
                ).status,
            ).toBe(202);
        }
        const computerId = fixture.runtime.computerId;
        const identity = { harness: "codex", directory: "." };
        // Obtain a valid discovery on the other Runtime through its public Platform API, so rejection cannot be
        // attributed to a nonexistent Runtime, entry, or discovery.
        const found = await fixture.runtime.client.runtimes.findNativeSessionBySessionId(
            { ...identity, sessionId },
            AbortSignal.timeout(10_000),
        );
        const before = await fixture.runtime.client.runtimes.listSessions(100, AbortSignal.timeout(10_000));
        const entry = { ...identity, computerId, directory: found.entry.directory };
        const paths = [
            { path: "native-sessions", input: { ...entry, action: "list", cursor: null } },
            { path: `native-session/${found.entry.sessionId}`, input: { ...entry } },
            {
                path: `native-session/${found.entry.sessionId}/import`,
                input: { ...entry },
            },
            { path: "native-session-forks/fork-operation", input: { ...entry, sessionId } },
        ];
        const responses = [];
        for (const { path, input } of paths) {
            const response = await owner.request(`chat/${path}`, input);
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
            expect((await owner.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
        }
        const managed = await owner.request(`chat/managed-sessions`, {});
        expect(managed.status).toBe(200);
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [
        { harness: "codex", label: "Codex" },
        { harness: "pi", label: "Pi" },
    ]);
    const setup = { computerId: fixture.runtime.computerId, harness: "codex" };
    expect((await fixture.request(`chat/setup`, setup)).status).toBe(202);

    const unavailable = await fixture.request(`chat/access`, {
        harness: "claude-code",
        configurations: [],
        conversationKey: "unavailable-agent",
        workspaceRef: ".",
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "AGENT_UNAVAILABLE" } });

    const opened = await fixture.request(`chat/access`, {
        harness: "pi",
        configurations: [],
        conversationKey: "agent-mismatch",
        workspaceRef: ".",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(v.object({ harness: v.string(), target: targetSchema }), await opened.json());
    expect(access.harness).toBe("pi");

    const restored = await fixture.request(`chat/managed-session`, {
        harness: "pi",
        sessionId: access.target.sessionId,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ harness: "pi" });
});

test("Given an imported native session, When its owner closes and explicitly imports it again, Then Chat reopens the canonical session without creating a duplicate", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, undefined, new Set([nativeId]));
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
    const identity = { computerId, harness: "codex", directory: "." };
    const listed = await fixture.request(`chat/native-sessions`, {
        ...identity,
        action: "list",
        cursor: null,
    });
    expect(listed.status).toBe(200);
    const discovery = v.parse(
        v.object({
            entries: v.array(v.object({ directory: v.string(), sessionId: v.string() })),
        }),
        await listed.json(),
    );
    const entry = v.parse(v.object({ directory: v.string(), sessionId: v.string() }), discovery.entries[0]);
    const sessionId = entry.sessionId;
    const path = `chat/native-session/${sessionId}/import`;
    const input = { ...identity, directory: entry.directory };
    const first = await fixture.request(path, input);
    expect(first.status).toBe(200);
    const opened = v.parse(v.object({ ready: v.object({ target: targetSchema }) }), await first.json());
    expect((await fixture.request("chat/managed-session/archive", opened.ready.target)).status).toBe(200);
    expect(await (await fixture.request("chat/managed-sessions", {})).json()).toEqual({ sessions: [] });
    const second = await fixture.request(path, input);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ready: { target: opened.ready.target } });
    const handoff = await fixture.request(`chat/continue-native-session`, {
        harness: "codex",
        sessionId: nativeId,
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ result: { ready: { target: opened.ready.target } } });
    const managed = await fixture.request(`chat/managed-sessions`, {});
    expect(await managed.json()).toMatchObject({ sessions: [{ target: opened.ready.target }] });
});

test("Given a managed Chat session is still running, When its owner archives it, Then Chat stops the Agent process and removes the session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "busy-archive",
        workspaceRef: ".",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    await fixture.runtime.client.turns.submitToRuntime(
        { harness: "codex", sessionId: sessionId },
        {
            harness: "codex",
            content: "wait for steering",
            directory: ".",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    const archived = await fixture.request(`chat/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
});

test("Given an idle managed Chat session, When its owner archives it, Then Chat rejects reopening its old conversation ID even though Runtime history remains", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "idle-archive",
        workspaceRef: ".",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;

    const reopened = await fixture.request(`chat/access`, {
        harness: "codex",
        sessionId: sessionId,
    });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ target: { harness: "codex", sessionId: sessionId } });

    const archived = await fixture.request(`chat/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const rejected = await fixture.request(`chat/access`, {
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
        expect((await fixture.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
        const opened = await fixture.request(`chat/access`, {
            harness: "codex",
            configurations: [],
            conversationKey: "concurrent-archive",
            workspaceRef: ".",
        });
        const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;

        const [reopened, archived] = await Promise.all([
            fixture.request(`chat/${operation}`, {
                harness: "codex",
                sessionId: sessionId,
            }),
            fixture.request(`chat/managed-session/archive`, {
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
        const rejected = await fixture.request(`chat/access`, {
            harness: "codex",
            sessionId: sessionId,
        });
        expect(rejected.status).toBe(404);
        const managed = await fixture.request(`chat/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Runtime cannot complete Session close, When its owner archives a managed Chat session, Then Chat reports the unconfirmed close and still archives it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const computerId = fixture.runtime.computerId;
    expect((await fixture.request(`chat/setup`, { computerId, harness: "codex" })).status).toBe(202);
    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "unavailable-close-archive",
        workspaceRef: ".",
    });
    const { sessionId } = v.parse(v.object({ target: targetSchema }), await opened.json()).target;
    await fixture.runtime[Symbol.asyncDispose]();

    const archived = await fixture.request(`chat/managed-session/archive`, {
        harness: "codex",
        sessionId: sessionId,
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "unconfirmed" });
    const managed = await fixture.request(`chat/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const repeated = await fixture.request(`chat/managed-session/archive`, {
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
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "revoked-while-open",
        workspaceRef: ".",
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
    expect(await revoked.json()).toEqual({ status: "access_revoked" });

    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
});

test("Given a browser following its chats' statuses, When the machine's owner revokes all access, Then the status stream ends without sending later statuses", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
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
    const opened = await fixture.request(`chat/access`, {
        harness: "codex",
        configurations: [],
        conversationKey: "followed-while-revoked",
        workspaceRef: ".",
    });
    const { target } = v.parse(v.object({ target: targetSchema }), await opened.json());
    const stream = await cloud.dispatchFetch(
        `${APP_ORIGIN}/morty/api/chat/computers/${fixture.computerId}/managed-session/status-events`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${browser}` },
        },
    );
    const reader = stream.body?.getReader();
    if (!reader) {
        throw new Error("Missing status stream");
    }
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("managed-session.statuses.following");

    expect(
        (await fixture.request("identity/revoke-all-access", { successor: `morty_anon_v1_${"A".repeat(43)}` })).status,
    ).toBe(200);
    await fixture.runtime.client.turns.submitToRuntime(
        target,
        {
            harness: "codex",
            content: "Reply after revoke",
            directory: ".",
            idempotencyKey: crypto.randomUUID(),
            attachments: [],
        },
        AbortSignal.timeout(10_000),
    );

    expect((await reader.read()).done).toBe(true);
});

test("Given two browsers joined through links, When one disconnects the other browsers, Then only it and the machine keep access and the other's open chat window is refused", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "codex",
            })
        ).status,
    ).toBe(202);
    const share = async () => {
        const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
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
    const asBrowser = (token: string, path: string, method = "GET", body?: object) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            cloud.environment(),
        );
    const opened = await asBrowser(other, `chat/computers/${fixture.computerId}/access`, "POST", {
        harness: "codex",
        configurations: [],
        conversationKey: "other-browser-window",
        workspaceRef: ".",
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
    expect(await ended.json()).toEqual({ status: "other_browser_access_ended" });
    expect((await asBrowser(owner, `computers/${fixture.computerId}/session`)).status).toBe(200);
    expect((await fixture.request("session")).status).toBe(200);
    const refused = await asBrowser(other, `computers/${fixture.computerId}/session`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { reason: "ACCESS_REVOKED" } });
    await expect(readHistory()).rejects.toMatchObject({ code: "credential_revoked" });
    expect((await redeem(unused)).status).toBe(410);
});

test("Given a browser connecting from a city, When it opens a link, Then the device list shows roughly where it joined, never what the browser claimed", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const shared = await fixture.request("identity/transfers", { operationId: crypto.randomUUID() });
    const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
    const redeemed = await cloud.dispatchFetch(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "Morty-Client-Location": encodeURIComponent(JSON.stringify({ city: "Elsewhere", country: "AQ" })),
        },
        body: JSON.stringify({ code, device: "iPhone · Safari" }),
        cf: { city: "Shanghai", country: "CN" },
    });
    expect(redeemed.status).toBe(200);

    const listed = v.parse(
        v.object({ devices: v.array(v.object({ label: v.nullable(v.string()), location: v.unknown() })) }),
        await (await fixture.request("identity/devices")).json(),
    );
    expect(listed.devices).toEqual([{ label: "iPhone · Safari", location: { city: "Shanghai", country: "CN" } }]);
});

test("Given an existing owned conversation, When a repeated start is refused, Then ownership remains", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, [{ harness: "configuration-test", label: "Settings Agent" }]);
    expect(
        (
            await fixture.request(`chat/setup`, {
                computerId: fixture.runtime.computerId,
                harness: "configuration-test",
            })
        ).status,
    ).toBe(202);
    const input = { harness: "configuration-test", conversationKey: "audit-retry", workspaceRef: "." };
    const started = await fixture.request(`chat/access`, { ...input, configurations: [] });
    expect(started.status).toBe(200);
    const { target } = v.parse(v.object({ target: targetSchema }), await started.json());
    expect(await (await fixture.request(`chat/managed-sessions`, {})).json()).toMatchObject({
        sessions: [{ target }],
    });
    const repeated = await fixture.request(`chat/access`, { ...input, configurations: [] });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ target });
    const refused = await fixture.request(`chat/access`, {
        ...input,
        configurations: [{ configId: "removed-setting", valueType: "select", value: "default", booleanValue: false }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    const access = await fixture.request(`chat/session-access`, {
        harness: "configuration-test",
        sessionId: target.sessionId,
    });
    const listed = await (await fixture.request(`chat/managed-sessions`, {})).json();
    expect(access.status).toBe(200);
    expect(listed).toMatchObject({ sessions: [{ target }] });
});
