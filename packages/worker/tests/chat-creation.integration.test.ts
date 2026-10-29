import * as v from "valibot";
import { afterEach, test as baseTest, beforeEach, expect, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

const test = baseTest.extend<{ readonly cloud: Awaited<ReturnType<typeof createIdentityFixture>> }>({
    cloud: [
        // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures declare their dependencies by destructuring.
        async ({}, use) => {
            const cloud = await createIdentityFixture();
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
    includePi = false,
    nativeSessionIds: ReadonlySet<string> = new Set(),
) {
    const identity = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(
        identity.projectId,
        [{ id: "codex", label: "Codex" }, ...(includePi ? [{ id: "pi", label: "Pi" }] : [])],
        nativeSessionIds,
    );
    const environment = cloud.environment();
    const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/morty/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/projects/${identity.projectId}/`) : `projects/${identity.projectId}/${path}`}`,
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
    const listed = await request("management/bots");
    const { bots } = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await listed.json());
    return {
        botId: v.parse(v.string(), bots[0]?.botId),
        projectId: identity.projectId,
        request,
        runtime,
        [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
    };
}

test("Given a draft Bot, When its owner configures and opens it, Then setup lists Runtime options and the Runtime endpoint exposes only the configured Runtime", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { runtimeId: fixture.runtime.runtimeId, agentRef: "codex" };
    expect(
        (
            await fixture.request(
                `management/bots/${fixture.botId}`,
                { displayName: "Test Bot", instructions: "Answer as the configured Chat Bot." },
                "PATCH",
            )
        ).status,
    ).toBe(200);
    const setupRuntimesResponse = await fixture.request(`chat/bots/${fixture.botId}/setup/runtimes`, {});
    expect(setupRuntimesResponse.status).toBe(200);
    const setupRuntimes = v.parse(
        v.strictObject({
            runtimes: v.array(
                v.strictObject({
                    runtimeId: v.string(),
                    machineName: v.string(),
                    online: v.boolean(),
                    agents: v.array(v.strictObject({ agentRef: v.string(), label: v.string() })),
                }),
            ),
        }),
        await setupRuntimesResponse.json(),
    );
    expect(setupRuntimes).toMatchObject({
        runtimes: [{ runtimeId: fixture.runtime.runtimeId, online: true, agents: [{ agentRef: "codex" }] }],
    });
    const draftRuntimeConfiguration = await fixture.request(`chat/bots/${fixture.botId}/workspace`, {});
    expect(draftRuntimeConfiguration.status).toBe(409);
    expect(await draftRuntimeConfiguration.json()).toMatchObject({ error: { code: "AGENT_REQUIRED" } });
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);

    const runtimeConfigurationResponse = await fixture.request(`chat/bots/${fixture.botId}/workspace`, {});
    expect(runtimeConfigurationResponse.status).toBe(200);
    expect(await runtimeConfigurationResponse.json()).toMatchObject({
        runtime: { runtimeId: fixture.runtime.runtimeId, online: true, agents: [{ agentRef: "codex" }] },
    });
    const configuredSetupRuntimes = await fixture.request(`chat/bots/${fixture.botId}/setup/runtimes`, {});
    expect(configuredSetupRuntimes.status).toBe(409);
    expect(await configuredSetupRuntimes.json()).toMatchObject({ error: { code: "BOT_RUNTIME_FIXED" } });

    const rebound = await fixture.request(`chat/bots/${fixture.botId}/setup`, {
        ...setup,
        runtimeId: "another-runtime",
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
        title: "New chat",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(
        v.object({ sessionId: v.string(), credential: v.string(), ready: v.unknown() }),
        await opened.json(),
    );
    expect(access.sessionId).toMatch(/^chat_[0-9a-f]{64}$/u);
    expect(access.credential).toMatch(/^msession_/u);

    const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(listed.status).toBe(200);
    const sessions = v.parse(
        v.object({
            sessions: v.array(
                v.object({
                    createdAt: v.pipe(v.string(), v.isoTimestamp()),
                    id: v.string(),
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
                id: access.sessionId,
                status: { kind: "idle" },
                updatedAt: AUTH_TIME.toISOString(),
            },
        ],
    });
});

for (const configured of [false, true]) {
    test(`Given a Bot ${configured ? "bound to another Runtime" : "without a Runtime"}, When its owner browses or opens native sessions using a client-selected Runtime, Then Chat rejects every operation without creating sessions or ownership records`, async ({
        cloud,
    }) => {
        const nativeSessionId = crypto.randomUUID();
        await using fixture = await createChatFixture(cloud, false, new Set([nativeSessionId]));
        await using bound = configured ? await cloud.connectAgent(fixture.projectId) : null;
        if (bound !== null) {
            expect(
                (
                    await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                        runtimeId: bound.runtimeId,
                        agentRef: "codex",
                    })
                ).status,
            ).toBe(202);
        }
        const runtimeId = fixture.runtime.runtimeId;
        const identity = { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
        // Obtain a valid discovery on the other Runtime through its public Platform API, so rejection cannot be
        // attributed to a nonexistent Runtime, entry, or discovery.
        const found = await fixture.runtime.client.runtimes.findNativeSessionByNativeSessionId(
            runtimeId,
            { ...identity, nativeSessionId },
            AbortSignal.timeout(10_000),
        );
        const before = await fixture.runtime.client.runtimes.listSessions(runtimeId, 100, AbortSignal.timeout(10_000));
        const entry = { ...identity, runtimeId, directoryId: found.entry.directoryId };
        const paths = [
            { path: "native-sessions", input: { ...entry, action: "list", cursor: null, discoveryId: null } },
            { path: `native-session/${found.entry.entryId}`, input: { ...entry, nativeSessionId } },
            ...["import", "fork"].map((action) => ({
                path: `native-session/${found.entry.entryId}/${action}`,
                input: { ...entry, discoveryId: found.sessionId },
            })),
        ];
        const responses = [];
        for (const { path, input } of paths) {
            const response = await fixture.request(`chat/bots/${fixture.botId}/${path}`, input);
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
            .soft(await fixture.runtime.client.runtimes.listSessions(runtimeId, 100, AbortSignal.timeout(10_000)))
            .toEqual(before);
        if (!configured) {
            expect(
                (await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status,
            ).toBe(202);
        }
        const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(managed.status).toBe(200);
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud, true);
    const setup = { runtimeId: fixture.runtime.runtimeId, agentRef: "codex" };
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);

    const unavailable = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "claude-code",
        configurations: [],
        conversationKey: "unavailable-agent",
        title: "New chat",
        workspaceRef: "default",
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "AGENT_UNAVAILABLE" } });

    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "pi",
        configurations: [],
        conversationKey: "agent-mismatch",
        title: "New chat",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const access = v.parse(v.object({ agentRef: v.string(), sessionId: v.string() }), await opened.json());
    expect(access.agentRef).toBe("pi");

    const restored = await fixture.request(`chat/bots/${fixture.botId}/managed-session`, {
        sessionId: access.sessionId,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ agentRef: "pi" });
});

test("Given an imported native session, When its owner imports it again, Then Chat reopens the canonical session without creating a duplicate", async ({
    cloud,
}) => {
    const nativeId = crypto.randomUUID();
    await using fixture = await createChatFixture(cloud, false, new Set([nativeId]));
    const runtimeId = fixture.runtime.runtimeId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status).toBe(
        202,
    );
    const identity = { runtimeId, agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
    const listed = await fixture.request(`chat/bots/${fixture.botId}/native-sessions`, {
        ...identity,
        action: "list",
        cursor: null,
        discoveryId: null,
    });
    expect(listed.status).toBe(200);
    const discovery = v.parse(
        v.object({
            sessionId: v.string(),
            entries: v.array(v.object({ directoryId: v.string(), entryId: v.string() })),
        }),
        await listed.json(),
    );
    const entry = v.parse(v.object({ directoryId: v.string(), entryId: v.string() }), discovery.entries[0]);
    const entryId = entry.entryId;
    const path = `chat/bots/${fixture.botId}/native-session/${entryId}/import`;
    const input = { ...identity, directoryId: entry.directoryId, discoveryId: discovery.sessionId };
    const first = await fixture.request(path, input);
    expect(first.status).toBe(200);
    const opened = v.parse(v.object({ ready: v.object({ sessionId: v.string() }) }), await first.json());
    const second = await fixture.request(path, input);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ready: { sessionId: opened.ready.sessionId } });
    const handoff = await fixture.request(`chat/bots/${fixture.botId}/continue-native-session`, {
        action: "import",
        harness: "codex",
        sessionId: nativeId,
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ result: { ready: { sessionId: opened.ready.sessionId } } });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toMatchObject({ sessions: [{ id: opened.ready.sessionId }] });
});

test("Given a managed Chat session is still running, When its owner archives it, Then Chat stops the Agent process and removes the session", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const runtimeId = fixture.runtime.runtimeId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "busy-archive",
        title: "New chat",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());
    await fixture.runtime.client.turns.submitToRuntime(
        runtimeId,
        sessionId,
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

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
});

test("Given an idle managed Chat session, When its owner archives it, Then Chat rejects reopening its old conversation ID even though Runtime history remains", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const runtimeId = fixture.runtime.runtimeId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "idle-archive",
        title: "New chat",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());

    const reopened = await fixture.request(`chat/bots/${fixture.botId}/access`, { conversationId: sessionId });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ conversationId: sessionId, sessionId });

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ close: "confirmed" });
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const rejected = await fixture.request(`chat/bots/${fixture.botId}/access`, { conversationId: sessionId });
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({
        error: {
            code: "NOT_FOUND",
            message:
                'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
        },
    });
    await expect(
        fixture.runtime.client.sessions.restore(runtimeId, sessionId, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({ ready: { sessionId } });
});

test("Given two Bots on the same Runtime, When a conversation ID is opened through the other Bot, Then Chat rejects it while its owner can still open it", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const setup = { runtimeId: fixture.runtime.runtimeId, agentRef: "codex" };
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);
    const created = await fixture.request("management/bots", { displayName: "Other Bot" });
    expect(created.status).toBe(201);
    const other = v.parse(v.object({ botId: v.string() }), await created.json());
    expect((await fixture.request(`chat/bots/${other.botId}/setup`, setup)).status).toBe(202);
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "owned-conversation",
        title: "New chat",
        workspaceRef: "default",
    });
    expect(opened.status).toBe(200);
    const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());

    const rejected = await fixture.request(`chat/bots/${other.botId}/access`, { conversationId: sessionId });

    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const reopened = await fixture.request(`chat/bots/${fixture.botId}/access`, { conversationId: sessionId });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ conversationId: sessionId, sessionId });
    const managed = await fixture.request(`chat/bots/${other.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
});

for (const operation of ["access", "managed-session"]) {
    test(`Given a managed Chat session, When ${operation} and archival run concurrently, Then the archived session stays closed and cannot be reopened through Morty`, async ({
        cloud,
    }) => {
        await using fixture = await createChatFixture(cloud);
        const runtimeId = fixture.runtime.runtimeId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status,
        ).toBe(202);
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "codex",
            configurations: [],
            conversationKey: "concurrent-archive",
            title: "New chat",
            workspaceRef: "default",
        });
        const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());

        const [reopened, archived] = await Promise.all([
            fixture.request(
                `chat/bots/${fixture.botId}/${operation}`,
                operation === "access" ? { conversationId: sessionId } : { sessionId },
            ),
            fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId }),
        ]);

        expect([200, 404]).toContain(reopened.status);
        expect(archived.status).toBe(200);
        expect(await archived.json()).toEqual({ close: "confirmed" });
        await expect(
            fixture.runtime.client.sessions.rename(runtimeId, sessionId, "Still closed", AbortSignal.timeout(10_000)),
        ).rejects.toMatchObject({ code: "session_closed" });
        const rejected = await fixture.request(`chat/bots/${fixture.botId}/access`, { conversationId: sessionId });
        expect(rejected.status).toBe(404);
        const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
    });
}

test("Given a Runtime cannot complete Session close, When its owner archives a managed Chat session, Then Chat reports the unconfirmed close while preserving legacy archival", async ({
    cloud,
}) => {
    await using fixture = await createChatFixture(cloud);
    const runtimeId = fixture.runtime.runtimeId;
    expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status).toBe(
        202,
    );
    const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
        agentRef: "codex",
        configurations: [],
        conversationKey: "unavailable-close-archive",
        title: "New chat",
        workspaceRef: "default",
    });
    const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());
    await fixture.runtime[Symbol.asyncDispose]();

    const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });

    expect(archived.status).toBe(200);
    const result: unknown = await archived.json();
    expect(result).toEqual({ close: "unconfirmed" });
    // The released browser at 830721ff accepts an object and ignores additional response fields.
    expect(v.parse(v.object({}), result)).toEqual({});
    const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
    expect(await managed.json()).toEqual({ sessions: [] });
    const repeated = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ close: "unconfirmed" });
});
