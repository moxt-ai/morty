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

test("Given a configured Bot, When its owner sends a private prompt, Then Platform runs the conversation and Morty lists it by opaque ownership", async () => {
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
        const access = v.parse(
            v.object({ sessionId: v.string(), credential: v.string(), ready: v.unknown() }),
            await opened.json(),
        );
        expect(access.sessionId).toMatch(/^chat_[0-9a-f]{64}$/u);
        expect(access.credential).toMatch(/^msession_/u);

        const turn = await fixture.request(`chat/bots/${fixture.botId}/turns`, {
            sessionId: access.sessionId,
            directoryId: "default",
            additionalDirectoryIds: [],
            content: "Create an image",
            idempotencyKey: "command-1",
            images: [{ data: "AQ==", mimeType: "image/png", name: "pixel.png" }],
            resources: [],
            sessionConfigurations: [],
        });
        expect(turn.status).toBe(200);
        expect(await turn.json()).toMatchObject({ turnId: "command-1" });
        const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(listed.status).toBe(200);
        expect(await listed.json()).toMatchObject({ sessions: [{ id: access.sessionId }] });
    } finally {
        await fixture.close();
    }
});
