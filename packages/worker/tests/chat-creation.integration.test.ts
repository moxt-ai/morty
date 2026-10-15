import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME } from "./support/clerk.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

async function createChatFixture(includeOpenCode = false, nativeSessionIds: ReadonlySet<string> = new Set()) {
    const cloud = await createIdentityFixture();
    try {
        const identity = await cloud.createAnonymousUser();
        const runtime = await cloud.connectAgent(
            identity.projectId,
            [{ id: "codex", label: "Codex" }, ...(includeOpenCode ? [{ id: "opencode", label: "OpenCode" }] : [])],
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
            request,
            runtime,
            close: cloud.close,
        };
    } catch (cause) {
        await cloud.close();
        throw cause;
    }
}

test("Given a draft Bot, When its owner configures and opens it, Then setup lists Runtime options and the Runtime endpoint exposes only the configured Runtime", async () => {
    const fixture = await createChatFixture();
    try {
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
    } finally {
        await fixture.close();
    }
});

test("Given a Bot connected through one Agent, When a Session uses another Agent, Then that Session reopens with its own Agent", async () => {
    const fixture = await createChatFixture(true);
    try {
        const setup = { runtimeId: fixture.runtime.runtimeId, agentRef: "codex" };
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
            agentRef: "opencode",
            configurations: [],
            conversationKey: "agent-mismatch",
            workspaceRef: "default",
        });
        expect(opened.status).toBe(200);
        const access = v.parse(v.object({ agentRef: v.string(), sessionId: v.string() }), await opened.json());
        expect(access.agentRef).toBe("opencode");

        const restored = await fixture.request(`chat/bots/${fixture.botId}/managed-session`, {
            sessionId: access.sessionId,
        });
        expect(restored.status).toBe(200);
        expect(await restored.json()).toMatchObject({ agentRef: "opencode" });
    } finally {
        await fixture.close();
    }
});

test("Given an imported native session, When its owner imports it again, Then Chat reopens the canonical session without creating a duplicate", async () => {
    const nativeId = crypto.randomUUID();
    const fixture = await createChatFixture(false, new Set([nativeId]));
    try {
        const runtimeId = fixture.runtime.runtimeId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status,
        ).toBe(202);
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
    } finally {
        await fixture.close();
    }
});

test("Given a managed Chat session is still running, When its owner archives it, Then Chat stops the Agent process and removes the session", async () => {
    const fixture = await createChatFixture();
    try {
        const runtimeId = fixture.runtime.runtimeId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status,
        ).toBe(202);
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "codex",
            configurations: [],
            conversationKey: "busy-archive",
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
                images: [],
                resources: [],
            },
            AbortSignal.timeout(10_000),
        );

        const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });

        expect(archived.status).toBe(200);
        const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
    } finally {
        await fixture.close();
    }
});

test("Given an idle managed Chat session, When its owner archives it, Then Chat removes it after closing its Agent session", async () => {
    const fixture = await createChatFixture();
    try {
        const runtimeId = fixture.runtime.runtimeId;
        expect(
            (await fixture.request(`chat/bots/${fixture.botId}/setup`, { runtimeId, agentRef: "codex" })).status,
        ).toBe(202);
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "codex",
            configurations: [],
            conversationKey: "idle-archive",
            workspaceRef: "default",
        });
        const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());

        const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, { sessionId });

        expect(archived.status).toBe(200);
        const managed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(await managed.json()).toEqual({ sessions: [] });
        await expect(
            fixture.runtime.client.sessions.restore(runtimeId, sessionId, AbortSignal.timeout(10_000)),
        ).resolves.toMatchObject({ ready: { sessionId } });
    } finally {
        await fixture.close();
    }
});
