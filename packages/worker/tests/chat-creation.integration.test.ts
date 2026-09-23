import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentMessageDeltaEvent,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeSessionFailedEvent,
    encodeAgentMessageDeltaEvent,
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
    agent: {
        readonly id: "codex" | "claude" | "opencode" | "pi";
        readonly name: string;
        readonly additionalAgents?: readonly {
            readonly id: "codex" | "claude" | "opencode" | "pi";
            readonly name: string;
        }[];
    } = {
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
            ...(agent.additionalAgents === undefined ? {} : { additionalAgents: agent.additionalAgents }),
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

test("Given a Bot with an existing Codex Session, When its owner selects Claude Code on the same Runtime, Then the old Session remains bound to Codex", async () => {
    const fixture = await createChatFixture(new Set(), {
        id: "codex",
        name: "Codex",
        additionalAgents: [{ id: "claude", name: "Claude Code" }],
    });
    try {
        const configure = (agentRef: "codex" | "claude") =>
            fixture.request(`chat/bots/${fixture.botId}/setup`, {
                runtimeId: fixture.runtime.runtimeId,
                agentRef,
            });
        expect((await configure("claude")).status).toBe(202);
        expect((await configure("codex")).status).toBe(202);
        const created = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
            action: "create",
        });
        expect(created.status).toBe(200);
        const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await created.json());

        const changed = await configure("claude");
        expect(changed.status).toBe(409);
        expect(await changed.json()).toMatchObject({ error: { code: "BOT_AGENT_FIXED" } });
        const access = await fixture.request(`chat/bots/${fixture.botId}/local-session-access`, { sessionId });
        expect(access.status).toBe(200);
        expect(await access.json()).toMatchObject({ configuration: { agentRef: "codex" } });
    } finally {
        await fixture.close();
    }
});

test("Given two Bots on one Runtime, When only one imports a native Session, Then the other Bot cannot use it until importing it", async () => {
    const nativeSessionId = crypto.randomUUID();
    const fixture = await createChatFixture(new Set([nativeSessionId]));
    try {
        const second = await fixture.request("management/bots", { displayName: "Second Bot" });
        expect(second.status).toBe(201);
        const { botId: secondBotId } = v.parse(v.object({ botId: v.string() }), await second.json());
        for (const botId of [fixture.botId, secondBotId]) {
            const configured = await fixture.request(`chat/bots/${botId}/setup`, {
                runtimeId: fixture.runtime.runtimeId,
                agentRef: "codex",
            });
            expect(configured.status).toBe(202);
        }
        const firstImport = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
            action: "import",
            sessionId: nativeSessionId,
        });
        expect(firstImport.status).toBe(200);
        const secondAccess = await fixture.request(`chat/bots/${secondBotId}/local-session-access`, {
            sessionId: nativeSessionId,
        });
        expect(secondAccess.status).toBe(404);
        const secondList = await fixture.request(`chat/bots/${secondBotId}/local-sessions`, {});
        expect(secondList.status).toBe(200);
        expect(await secondList.json()).toMatchObject({ sessions: [] });

        const openSecondChannel = async () => {
            const response = await fixture.dispatchFetch(
                `${APP_ORIGIN}/morty/api/chat/projects/${fixture.projectId}/bots/${secondBotId}/runtime-channel`,
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
                throw new Error("The second Bot Runtime channel did not upgrade.");
            }
            socket.accept();
            return socket;
        };
        const prompt = (commandId: string) =>
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: secondBotId,
                commandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: SESSION_PROMPT_KIND,
                prompt: "Hello from the second Bot",
                resources: [],
                sessionId: nativeSessionId,
                targetCommandId: "",
            });
        const deniedSocket = await openSecondChannel();
        const denied = new Promise<number>((resolve) =>
            deniedSocket.addEventListener("close", (event) => resolve(event.code), { once: true }),
        );
        deniedSocket.send(prompt("unowned_prompt"));
        expect(await denied).toBe(1008);

        const secondImport = await fixture.request(`chat/bots/${secondBotId}/local-sessions/create`, {
            action: "import",
            sessionId: nativeSessionId,
        });
        expect(secondImport.status).toBe(200);
        const allowedSocket = await openSecondChannel();
        const reply = new Promise<string>((resolve, reject) => {
            allowedSocket.addEventListener(
                "close",
                () => reject(new Error("Imported Session channel closed before replying")),
                {
                    once: true,
                },
            );
            allowedSocket.addEventListener("message", (event) => {
                if (typeof event.data !== "string" || decodeMessageKind(event.data) !== SESSION_EVENT_COMMITTED_KIND) {
                    return;
                }
                const committed = decodeCommittedSessionEvent(event.data);
                if (decodeMessageKind(committed.payload) !== AGENT_MESSAGE_DELTA_KIND) {
                    return;
                }
                const delta = decodeAgentMessageDeltaEvent(committed.payload);
                if (delta.commandId === "imported_prompt") {
                    resolve(delta.text);
                }
            });
        });
        allowedSocket.send(prompt("imported_prompt"));
        expect(await reply).toContain("Hello from the second Bot");
        allowedSocket.close(1000, "Test complete");
    } finally {
        await fixture.close();
    }
}, 15_000);

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

test("Given two owned Sessions on one Runtime channel, When committed events arrive in source order, Then the browser receives that same order", async () => {
    const fixture = await createChatFixture();
    try {
        const configured = await fixture.request(`chat/bots/${fixture.botId}/setup`, {
            runtimeId: fixture.runtime.runtimeId,
            agentRef: "codex",
        });
        expect(configured.status).toBe(202);
        const create = async () => {
            const response = await fixture.request(`chat/bots/${fixture.botId}/local-sessions/create`, {
                action: "create",
            });
            expect(response.status).toBe(200);
            return v.parse(v.object({ sessionId: v.string() }), await response.json()).sessionId;
        };
        const firstSessionId = await create();
        const secondSessionId = await create();
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
            throw new Error("The Runtime channel did not upgrade.");
        }
        socket.accept();
        const preauthorized = new Promise<void>((resolve, reject) => {
            socket.addEventListener("close", () => reject(new Error("Runtime channel closed before authorization")), {
                once: true,
            });
            socket.addEventListener("message", (event) => {
                if (typeof event.data !== "string" || decodeMessageKind(event.data) !== SESSION_EVENT_COMMITTED_KIND) {
                    return;
                }
                const committed = decodeCommittedSessionEvent(event.data);
                if (decodeMessageKind(committed.payload) !== AGENT_MESSAGE_DELTA_KIND) {
                    return;
                }
                const delta = decodeAgentMessageDeltaEvent(committed.payload);
                if (delta.commandId === "preauthorize_second") {
                    resolve();
                }
            });
        });
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: fixture.botId,
                commandId: "preauthorize_second",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: SESSION_PROMPT_KIND,
                prompt: "Authorize the second Session",
                resources: [],
                sessionId: secondSessionId,
                targetCommandId: "",
            }),
        );
        await preauthorized;

        const received = new Promise<readonly string[]>((resolve, reject) => {
            const messages: string[] = [];
            socket.addEventListener("close", () => reject(new Error("Runtime channel closed before both events")), {
                once: true,
            });
            socket.addEventListener("message", (event) => {
                if (typeof event.data !== "string" || decodeMessageKind(event.data) !== SESSION_EVENT_COMMITTED_KIND) {
                    return;
                }
                const committed = decodeCommittedSessionEvent(event.data);
                if (decodeMessageKind(committed.payload) !== AGENT_MESSAGE_DELTA_KIND) {
                    return;
                }
                const delta = decodeAgentMessageDeltaEvent(committed.payload);
                if (delta.text === "first-order-event" || delta.text === "second-order-event") {
                    messages.push(delta.text);
                    if (messages.length === 2) {
                        resolve(messages);
                    }
                }
            });
        });
        const payload = (sessionId: string, text: string) =>
            encodeAgentMessageDeltaEvent({
                commandId: crypto.randomUUID(),
                epoch: crypto.randomUUID(),
                kind: "agent.message.delta",
                messageId: crypto.randomUUID(),
                sequence: 1,
                sessionId,
                text,
            });
        await fixture.runtime.publishSessionEvent(
            firstSessionId,
            payload(firstSessionId, "first-order-event"),
            AbortSignal.timeout(10_000),
        );
        await fixture.runtime.publishSessionEvent(
            secondSessionId,
            payload(secondSessionId, "second-order-event"),
            AbortSignal.timeout(10_000),
        );
        expect(await received).toEqual(["first-order-event", "second-order-event"]);
        socket.close(1000, "Test complete");
    } finally {
        await fixture.close();
    }
}, 15_000);

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
