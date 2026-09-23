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

async function createChatFixture(
    nativeSessionIds: ReadonlySet<string> = new Set(),
    agent: { readonly id: "codex" | "claude"; readonly name: string } = { id: "codex", name: "Codex" },
) {
    const cloud = await createIdentityFixture();
    try {
        const identity = await cloud.createAnonymousUser();
        const runtime = await cloud.connectAgent(identity.projectId, {
            nativeSessionIds,
            agentId: agent.id,
            agentName: agent.name,
        });
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

test("given a configured Bot, when a user opens a conversation, then the unavailable feature is explicit", async () => {
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
        expect((await fixture.request(`chat/bots/${fixture.botId}/workspace`, {})).status).toBe(200);
        expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setup)).status).toBe(202);

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
        ).toBe(404);

        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: setup.agentRef,
            configurations: [],
            conversationKey: "first-draft",
            workspaceRef: "default",
        });
        expect(opened.status).toBe(404);

        const turn = await fixture.request(`chat/bots/${fixture.botId}/turns`, {
            sessionId: "first-draft",
            additionalDirectoryIds: [],
            content: "Create an image",
            idempotencyKey: "command-1",
            images: [{ data: "AQ==", mimeType: "image/png", name: "pixel.png" }],
            resources: [],
            sessionConfigurations: [],
        });
        expect(turn.status).toBe(404);

        const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(listed.status).toBe(404);
    } finally {
        await fixture.close();
    }
});

test.each([
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude Code" },
] as const)(
    "Given a configured $name Bot, When its owner starts a local conversation, Then Chat records only the Session ownership needed for Runtime access",
    async (agent) => {
        const existingSessionId = crypto.randomUUID();
        const fixture = await createChatFixture(new Set([existingSessionId]), agent);
        try {
            expect(
                (
                    await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                        runtimeId: fixture.runtime.runtimeId,
                        agentRef: agent.id,
                    })
                ).status,
            ).toBe(202);
            const created = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
                action: "create",
            });
            expect(created.status).toBe(200);
            const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await created.json());
            expect(sessionId).toMatch(/^[0-9a-f-]{36}$/iu);

            const listed = await fixture.request(`chat/bots/${fixture.botId}/local-sessions`, {});
            expect(listed.status).toBe(200);
            expect(await listed.json()).toMatchObject({ sessions: [{ id: sessionId, isExternal: false }] });

            expect(
                (await fixture.request(`chat/bots/${fixture.botId}/local-session-access`, { sessionId })).status,
            ).toBe(200);
            const unrelated = await fixture.request(`chat/bots/${fixture.botId}/local-session-access`, {
                sessionId: "chat_unowned",
            });
            expect(unrelated.status).toBe(404);

            const imported = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
                action: "import",
                sessionId: existingSessionId,
            });
            expect(imported.status).toBe(200);
            expect(await imported.json()).toMatchObject({ sessionId: existingSessionId });
        } finally {
            await fixture.close();
        }
    },
);
