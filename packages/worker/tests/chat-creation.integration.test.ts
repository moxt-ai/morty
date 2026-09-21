import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME } from "./support/clerk.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";
import { platformPeer } from "./support/platform-peer.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

async function createChatFixture({
    settingsAvailable = true,
    settingsFailure = "api-error",
}: {
    readonly settingsAvailable?: boolean;
    readonly settingsFailure?: "api-error" | "invalid-json";
} = {}) {
    const platform = await platformPeer({ agentsOnline: true, settingsAvailable, settingsFailure });
    const cloud = await createIdentityFixture({
        platform: {
            appId: platform.bindings.MOBIUS_APP_ID,
            appCredential: platform.bindings.MOBIUS_APP_SECRET,
            baseUrl: platform.bindings.MOBIUS_BASE_URL,
            close: platform.close,
        },
    });
    try {
        const identity = await cloud.createAnonymousUser();
        const environment = cloud.environment();
        const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            worker.fetch(
                new Request(
                    `${APP_ORIGIN}/mobius-cloud/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/projects/${identity.projectId}/`) : `projects/${identity.projectId}/${path}`}`,
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
        const botId = v.parse(v.string(), bots[0]?.botId);
        return {
            botId,
            identity,
            platform,
            request,
            close: cloud.close,
        };
    } catch (cause) {
        await cloud.close();
        throw cause;
    }
}

const setupInput = {
    runtimeId: "runtime-1",
    agentRef: "agent-one",
};

test("Given a Bot bound to one Runtime, When setup requests another Runtime, Then the original Runtime binding remains fixed", async () => {
    const fixture = await createChatFixture();
    try {
        expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setupInput)).status).toBe(202);
        const rebound = await fixture.request(`chat/bots/${fixture.botId}/setup`, {
            ...setupInput,
            runtimeId: "runtime-2",
        });
        expect(rebound.status).toBe(409);
        expect(await rebound.json()).toMatchObject({ error: { code: "BOT_RUNTIME_FIXED" } });
    } finally {
        await fixture.close();
    }
});

test("Given a conversation bound to one Agent, When another Agent is selected, Then the existing conversation reopens with its original Agent", async () => {
    const fixture = await createChatFixture();
    try {
        expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setupInput)).status).toBe(202);
        const settings = await fixture.request(`chat/bots/${fixture.botId}/agent-settings`, {
            agentRef: "agent-one",
        });
        expect(settings.status).toBe(200);
        const created = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "agent-one",
            configurations: [],
            conversationKey: "original-agent",
            workspaceRef: "default",
        });
        const { conversationId } = v.parse(v.object({ conversationId: v.string() }), await created.json());

        const changed = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: "agent-two",
            configurations: [],
            conversationKey: "changed-agent",
            workspaceRef: "default",
        });
        expect(changed.status).toBe(200);
        expect(await changed.json()).toMatchObject({ agentRef: "agent-two" });
        const reopened = await fixture.request(`chat/bots/${fixture.botId}/access`, { conversationId });

        expect(reopened.status).toBe(200);
        expect(await reopened.json()).toMatchObject({ agentRef: "agent-one", conversationId });
    } finally {
        await fixture.close();
    }
});

test("Given an available Runtime, When a Bot is configured and used, Then settings, conversations, media, and instructions cross the Platform boundary", async () => {
    const fixture = await createChatFixture();
    try {
        const profile = await fixture.request(
            `management/bots/${fixture.botId}`,
            { displayName: "Test Bot", instructions: "Answer as the configured Chat Bot." },
            "PATCH",
        );
        expect(profile.status).toBe(200);
        expect((await fixture.request(`chat/bots/${fixture.botId}/workspace`, {})).status).toBe(200);
        expect((await fixture.request(`chat/bots/${fixture.botId}/setup`, setupInput)).status).toBe(202);

        const prepared = await fixture.request(`chat/bots/${fixture.botId}/agent-settings`, {
            agentRef: setupInput.agentRef,
        });
        expect(prepared.status).toBe(200);
        expect(
            await (
                await fixture.request(`chat/bots/${fixture.botId}/workspace/directory`, { directoryId: "default" })
            ).json(),
        ).toMatchObject({
            directoryLabel: "/home/a/mobius.t3",
            entries: [
                {
                    directoryId: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
                    name: "selected-project",
                },
            ],
        });

        const selection = {
            agentRef: setupInput.agentRef,
            conversationKey: "first-draft",
            workspaceRef: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
            configurations: [
                { booleanValue: false, configId: "model", value: "model-two", valueType: "select" },
                { booleanValue: true, configId: "fast_mode", value: "", valueType: "boolean" },
                {
                    booleanValue: false,
                    configId: "opencode_permission",
                    value: "read-only",
                    valueType: "select",
                },
            ],
        };
        const opened = await fixture.request(`chat/bots/${fixture.botId}/access`, selection);
        expect(opened.status).toBe(200);
        const first = v.parse(v.object({ conversationId: v.string() }), await opened.json());
        expect(fixture.platform.configuredSettings()).toEqual(selection.configurations.slice(0, 2));

        const image = { data: "A".repeat(3_000_000), mimeType: "image/png", name: "large-screenshot.png" };
        const turn = await fixture.request(`chat/bots/${fixture.botId}/turns`, {
            sessionId: first.conversationId,
            additionalDirectoryIds: [],
            artifactIds: [],
            content: "Hello",
            idempotencyKey: "command-1",
            images: [image],
            resources: [],
            sessionConfigurations: selection.configurations,
        });
        expect(turn.status).toBe(200);
        expect(fixture.platform.submittedTurns()).toMatchObject([
            {
                images: [image],
                sessionConfigurations: selection.configurations,
                resources: [
                    {
                        type: "embedded",
                        uri: "mobius-chat://bot/instructions",
                        name: "Bot instructions",
                        text: "Answer as the configured Chat Bot.",
                    },
                ],
            },
        ]);

        const second = await fixture.request(`chat/bots/${fixture.botId}/access`, {
            agentRef: setupInput.agentRef,
            conversationKey: "second-draft",
            permissionMode: "read-only",
            configuration: {
                additionalDirectoryIds: [],
                booleanValue: false,
                configId: "model",
                value: "model-one",
                valueType: "select",
            },
            workspaceRef: selection.workspaceRef,
        });
        expect(second.status).toBe(200);
        const secondConversation = v.parse(v.object({ conversationId: v.string() }), await second.json());
        expect(secondConversation.conversationId).not.toBe(first.conversationId);
        expect(fixture.platform.configuredSettings()).toEqual([
            ...selection.configurations.slice(0, 2),
            {
                booleanValue: false,
                configId: "permission_mode",
                value: "read-only",
                valueType: "select",
            },
            {
                booleanValue: false,
                configId: "model",
                value: "model-one",
                valueType: "select",
            },
        ]);
        const listed = await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {});
        expect(await listed.json()).toMatchObject({
            sessions: expect.arrayContaining([
                expect.objectContaining({ id: first.conversationId, title: "New chat" }),
                expect.objectContaining({ id: secondConversation.conversationId, title: "New chat" }),
            ]),
        });
        const archived = await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
            sessionId: first.conversationId,
        });
        expect(archived.status).toBe(200);
        expect(await archived.json()).toEqual({});
        expect(await (await fixture.request(`chat/bots/${fixture.botId}/managed-sessions`, {})).json()).toMatchObject({
            sessions: [expect.objectContaining({ id: secondConversation.conversationId, title: "New chat" })],
        });
        expect(
            (
                await fixture.request(`chat/bots/${fixture.botId}/managed-session/archive`, {
                    sessionId: first.conversationId,
                })
            ).status,
        ).toBe(404);
    } finally {
        await fixture.close();
    }
});

test.each([
    {
        description: "rejects an unavailable Agent",
        settingsFailure: "api-error" as const,
        expectedStatus: 409,
        expectedError: {
            code: "agent_unavailable",
            message: "Platform could not complete Runtime setup. Cause: The settings agent is unavailable",
        },
    },
    {
        description: "rejects an invalid Platform response",
        settingsFailure: "invalid-json" as const,
        expectedStatus: 502,
        expectedError: {
            code: "invalid_service_response",
            message: "Platform could not complete Runtime setup. Cause: The service returned invalid JSON",
        },
    },
])(
    "Given a Platform fault, When Chat configures a Bot, Then it $description",
    async ({ settingsFailure, expectedStatus, expectedError }) => {
        const fixture = await createChatFixture({ settingsAvailable: false, settingsFailure });
        try {
            const response = await fixture.request(`chat/bots/${fixture.botId}/setup`, setupInput);
            expect(response.status).toBe(expectedStatus);
            expect(await response.json()).toEqual({ error: expectedError });
        } finally {
            await fixture.close();
        }
    },
);
