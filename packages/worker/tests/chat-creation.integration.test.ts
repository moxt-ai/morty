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

async function createChatFixture() {
    const cloud = await createIdentityFixture();
    try {
        const identity = await cloud.createAnonymousUser();
        const runtime = await cloud.connectAgent(identity.projectId);
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

test("a Bot uses the real Platform journey for setup, chat, media, listing, and archival", async () => {
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
        ).toBe(200);

        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: setup.agentRef,
            configurations: [],
            conversationKey: "first-draft",
            workspaceRef: "default",
        });
        expect(opened.status).toBe(200);
        const { conversationId } = v.parse(v.object({ conversationId: v.string() }), await opened.json());

        const turn = await fixture.request(`chat/bots/${fixture.botId}/turns`, {
            sessionId: conversationId,
            additionalDirectoryIds: [],
            artifactIds: [],
            content: "Create an image",
            idempotencyKey: "command-1",
            images: [{ data: "AQ==", mimeType: "image/png", name: "pixel.png" }],
            resources: [],
            sessionConfigurations: [],
        });
        expect(turn.status).toBe(200);

        expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toMatchObject({
            sessions: [expect.objectContaining({ id: conversationId, title: "New chat" })],
        });
        expect(
            (
                await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
                    sessionId: conversationId,
                })
            ).status,
        ).toBe(200);
        expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toMatchObject({
            sessions: [],
        });
    } finally {
        await fixture.close();
    }
});
