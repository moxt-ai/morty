import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentMessageDeltaEvent,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeSessionFailedEvent,
    encodeSessionPromptCommand,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
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
    agent: { readonly id: "codex" | "claude" | "opencode" | "pi"; readonly name: string } = {
        id: "codex",
        name: "Codex",
    },
) {
    const cloud = await createIdentityFixture();
    try {
        const identity = await cloud.createAnonymousUser();
        const runtime = await cloud.connectAgent(identity.projectId, {
            nativeSessionIds,
            agentId: agent.id,
            agentName: agent.name,
            requiredBindingId: "workspace",
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
            dispatchFetch: cloud.dispatchFetch,
            projectId: identity.projectId,
            token: identity.token,
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
    { id: "opencode", name: "OpenCode" },
    { id: "pi", name: "Pi" },
] as const)(
    "Given a configured $name Bot, When its owner starts a local conversation, Then Chat records only the Session ownership needed for Runtime access",
    async (agent) => {
        const existingSessionId =
            agent.id === "opencode" ? `ses_${crypto.randomUUID().replaceAll("-", "")}` : crypto.randomUUID();
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
            expect(sessionId).toMatch(agent.id === "opencode" ? /^ses_[a-z0-9]+$/iu : /^[0-9a-f-]{36}$/iu);

            const listed = await fixture.request(`chat/bots/${fixture.botId}/local-sessions`, {});
            expect(listed.status).toBe(200);
            expect(await listed.json()).toMatchObject({ sessions: [{ id: sessionId }] });

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

test.each([
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude Code" },
    { id: "opencode", name: "OpenCode" },
    { id: "pi", name: "Pi" },
] as const)(
    "Given a $name Bot and owned native Session, When Chat sends through its Runtime channel, Then the local Agent replies",
    async (agent) => {
        const fixture = await createChatFixture(new Set(), agent);
        try {
            const configured = await fixture.request(`chat/bots/${fixture.botId}/setup`, {
                runtimeId: fixture.runtime.runtimeId,
                agentRef: agent.id,
            });
            expect(configured.status).toBe(202);
            const opened = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
                action: "create",
            });
            expect(opened.status).toBe(200);
            const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await opened.json());
            const response = await fixture.dispatchFetch(
                `${APP_ORIGIN}/morty/api/chat/projects/${fixture.projectId}/bots/${fixture.botId}/runtime-channel`,
                {
                    headers: {
                        Upgrade: "websocket",
                        Origin: APP_ORIGIN,
                        "Sec-WebSocket-Protocol": `morty-runtime, auth.${fixture.token}`,
                    },
                },
            );
            expect(response.status).toBe(101);
            const socket = response.webSocket;
            if (socket === null) {
                throw new Error("The Runtime channel did not upgrade");
            }
            socket.accept();
            const commandId = "bot_prompt_1";
            const reply = new Promise<string>((resolve, reject) => {
                socket.addEventListener("close", () => reject(new Error("Runtime channel closed before replying")), {
                    once: true,
                });
                socket.addEventListener("message", (event) => {
                    if (
                        typeof event.data !== "string" ||
                        decodeMessageKind(event.data) !== SESSION_EVENT_COMMITTED_KIND
                    ) {
                        return;
                    }
                    const committed = decodeCommittedSessionEvent(event.data);
                    const kind = decodeMessageKind(committed.payload);
                    if (kind === SESSION_FAILED_KIND) {
                        const failure = decodeSessionFailedEvent(committed.payload);
                        if (failure.commandId === commandId) {
                            reject(new Error(failure.code));
                        }
                        return;
                    }
                    if (kind !== AGENT_MESSAGE_DELTA_KIND) {
                        return;
                    }
                    const delta = decodeAgentMessageDeltaEvent(committed.payload);
                    if (delta.commandId === commandId) {
                        resolve(delta.text);
                    }
                });
            });
            socket.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: fixture.botId,
                    commandId,
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "Hello from Chat",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
            expect(await reply).toContain("Hello from Chat");
            socket.close(1000, "Test complete");
        } finally {
            await fixture.close();
        }
    },
    15_000,
);
