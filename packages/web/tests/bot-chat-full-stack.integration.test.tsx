import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    encodeSessionPermissionRequestedEvent,
    type NativeHistoryImage,
    type NativeHistoryMessage,
    type NativeSessionHistory,
    type SessionElicitationRequestedEvent,
    type SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../../worker/src/application.ts";
import { createIdentityFixture } from "../../worker/tests/support/identity-fixture.ts";
import { ToastProvider } from "../src/components/ui/toast.tsx";
import { ApiTransportProvider } from "../src/services/api/api-transport-context.tsx";
import { WebSocketApiTransport } from "../src/services/api/websocket-api-transport.ts";
import { WorkspaceApplication } from "../src/views/authentication/session-application.tsx";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The Chat Worker port was unavailable.");
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return address.port;
}

function waitForButton(label: string): Promise<HTMLButtonElement> {
    return new Promise((resolve) => {
        const find = () =>
            [...document.querySelectorAll<HTMLButtonElement>("button")].find(
                (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
            );
        const current = find();
        if (current !== undefined) {
            resolve(current);
            return;
        }
        const observer = new MutationObserver(() => {
            const button = find();
            if (button !== undefined) {
                observer.disconnect();
                resolve(button);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

function waitForButtonContaining(text: string): Promise<HTMLButtonElement> {
    return new Promise((resolve) => {
        const find = () =>
            [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
                button.textContent?.includes(text),
            );
        const current = find();
        if (current !== undefined) {
            resolve(current);
            return;
        }
        const observer = new MutationObserver(() => {
            const button = find();
            if (button !== undefined) {
                observer.disconnect();
                resolve(button);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

function waitForText(text: string): Promise<void> {
    return new Promise((resolve) => {
        if (document.body.textContent?.includes(text)) {
            resolve();
            return;
        }
        const observer = new MutationObserver(() => {
            if (document.body.textContent?.includes(text)) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

function waitForTextIn(container: Element, text: string): Promise<void> {
    return new Promise((resolve) => {
        if (container.textContent?.includes(text)) {
            resolve();
            return;
        }
        const observer = new MutationObserver(() => {
            if (container.textContent?.includes(text)) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
}

function waitForMessageIn(container: Element, label: string, text: string): Promise<void> {
    return new Promise((resolve) => {
        const find = () =>
            [...container.querySelectorAll<HTMLElement>(`article[aria-label="${label}"]`)].some((message) =>
                message.textContent?.includes(text),
            );
        if (find()) {
            resolve();
            return;
        }
        const observer = new MutationObserver(() => {
            if (find()) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
}

function waitForTextGone(text: string): Promise<void> {
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (!document.body.textContent?.includes(text)) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

function waitForMessageInput(): Promise<void> {
    return new Promise((resolve) => {
        if (document.querySelector('textarea[aria-label="Message"]') !== null) {
            resolve();
            return;
        }
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea[aria-label="Message"]') !== null) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function waitForEnabledSendButton(): Promise<HTMLButtonElement> {
    return new Promise((resolve) => {
        const find = () =>
            document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]:not(:disabled)');
        const current = find();
        if (current !== null) {
            resolve(current);
            return;
        }
        const observer = new MutationObserver(() => {
            const button = find();
            if (button !== null) {
                observer.disconnect();
                resolve(button);
            }
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    });
}

function waitForInput(label: string): Promise<HTMLInputElement> {
    return new Promise((resolve) => {
        const find = () =>
            [...document.querySelectorAll<HTMLInputElement>("input")].find(
                (input) =>
                    input.getAttribute("aria-label") === label ||
                    [...(input.labels ?? [])].some((candidate) => candidate.textContent?.trim() === label),
            );
        const current = find();
        if (current !== undefined) {
            resolve(current);
            return;
        }
        const observer = new MutationObserver(() => {
            const input = find();
            if (input !== undefined) {
                observer.disconnect();
                resolve(input);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function waitForImage(name: string): Promise<HTMLImageElement> {
    return new Promise((resolve) => {
        const find = () => [...document.querySelectorAll<HTMLImageElement>("img")].find((image) => image.alt === name);
        const current = find();
        if (current !== undefined) {
            resolve(current);
            return;
        }
        const observer = new MutationObserver(() => {
            const image = find();
            if (image !== undefined) {
                observer.disconnect();
                resolve(image);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function pauseGate() {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    return {
        entered: entered.promise,
        release: () => released.resolve(),
        wait: async (signal: AbortSignal) => {
            entered.resolve();
            signal.throwIfAborted();
            await new Promise<void>((resolveWait, rejectWait) => {
                const cleanup = () => signal.removeEventListener("abort", abort);
                const abort = () => {
                    cleanup();
                    rejectWait(signal.reason);
                };
                signal.addEventListener("abort", abort, { once: true });
                void released.promise.then(() => {
                    cleanup();
                    resolveWait();
                });
            });
        },
    };
}

function longHistory(): readonly NativeHistoryMessage[] {
    const messages: NativeHistoryMessage[] = [];
    for (let index = 1; index <= 84; index += 1) {
        messages.push({ role: "user", text: `Question ${index.toString()}` });
    }
    messages.push({ role: "assistant", text: "Recent answer", activities: [], content: [] });
    return messages;
}

let fixture: Awaited<ReturnType<typeof createIdentityFixture>> | null = null;

function activeFixture(): Awaited<ReturnType<typeof createIdentityFixture>> {
    if (fixture === null) {
        throw new Error("The real Chat and Platform test stack did not start.");
    }
    return fixture;
}

async function createIdentity() {
    const cloud = activeFixture();
    const created = await cloud.dispatchFetch(`${cloud.origin}/morty/api/identity/anonymous-users`, {
        method: "POST",
    });
    expect(created.status).toBe(201);
    return v.parse(v.object({ token: v.string(), userId: v.string(), projectId: v.string() }), await created.json());
}

async function chatRequest(identity: Awaited<ReturnType<typeof createIdentity>>, path: string, body?: object) {
    const cloud = activeFixture();
    return await cloud.dispatchFetch(`${cloud.origin}/morty/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${identity.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function connectFakeRuntime(
    cloud: Awaited<ReturnType<typeof createIdentityFixture>>,
    projectId: string,
    options: {
        readonly pauseHistory?: "all" | string;
        readonly pauseActiveSnapshot?: boolean;
        readonly pauseAfterLastDelta?: boolean;
        readonly pausePrompt?: "before-delta" | "after-delta" | "after-last-delta";
        readonly truncateHistory?: boolean;
    } = {},
) {
    const sessions = new Map<string, readonly NativeHistoryMessage[]>();
    const sessionIds = new Set<string>();
    let pausedHistory = options.pauseHistory;
    let pausedActiveSnapshot = options.pauseActiveSnapshot ?? false;
    let activeCommandId: string | null = null;
    let activeInteraction: SessionPermissionRequestedEvent | SessionElicitationRequestedEvent | null = null;
    const historyGate = pauseGate();
    const activeSnapshotGate = pauseGate();
    const promptGate = pauseGate();
    const lastDeltaGate = pauseGate();
    const runtime = await cloud.connectAgent(projectId, {
        agentId: "claude",
        agentName: "Claude Code",
        nativeSessionIds: sessionIds,
        nativeSessionTitle: (sessionId) => sessions.get(sessionId)?.[0]?.text ?? "New chat",
        loadNativeHistory: async (sessionId, signal): Promise<NativeSessionHistory> => {
            if (pausedHistory === "all" || pausedHistory === sessionId) {
                await historyGate.wait(signal);
            }
            const messages = sessions.get(sessionId);
            return messages === undefined
                ? { status: "unavailable", cause: { code: "native_session_not_found", message: "Session not found" } }
                : {
                      status: "available",
                      messages: options.truncateHistory ? messages.slice(-10) : messages,
                      truncated: options.truncateHistory === true && messages.length > 10,
                      coveredCommandIds: [],
                      coveredMessageIds: [],
                  };
        },
        beforeActiveTurnSnapshot: async (_sessionId, signal) => {
            if (pausedActiveSnapshot) {
                await activeSnapshotGate.wait(signal);
            }
        },
        activeInteraction: () => activeInteraction,
        afterSessionStarted: async (_command, signal) => {
            activeCommandId = _command.commandId;
            if (options.pausePrompt === "before-delta") {
                await promptGate.wait(signal);
            }
        },
        afterFirstDelta: async (_command, signal) => {
            if (options.pausePrompt === "after-delta") {
                await promptGate.wait(signal);
            }
        },
        afterLastDelta: async (_command, signal) => {
            if (options.pausePrompt === "after-last-delta") {
                await promptGate.wait(signal);
            } else if (options.pauseAfterLastDelta) {
                await lastDeltaGate.wait(signal);
            }
        },
        responseParts: (command, turn) =>
            command.prompt === "hold after large output"
                ? [...Array.from({ length: 20 }, () => "x".repeat(10_000)), "END"]
                : command.prompt.includes("after first delta")
                  ? ["Partial reply", " and more"]
                  : [`Claude Code turn ${turn.toString()}: ${command.prompt}`],
        onPromptCompleted: (command, response) => {
            const previous = sessions.get(command.sessionId) ?? [];
            sessions.set(command.sessionId, [
                ...previous,
                { role: "user", text: command.prompt },
                { role: "assistant", text: response, activities: [], content: [] },
            ]);
        },
    });
    return {
        ...runtime,
        historyGate,
        activeSnapshotGate,
        promptGate,
        lastDeltaGate,
        activeCommandId: () => activeCommandId,
        setActiveInteraction: (
            interaction: SessionPermissionRequestedEvent | SessionElicitationRequestedEvent | null,
        ) => {
            activeInteraction = interaction;
        },
        holdHistory: (sessionId: string) => {
            pausedHistory = sessionId;
        },
        holdActiveSnapshot: () => {
            pausedActiveSnapshot = true;
        },
        seedNativeSession: async (
            sessionId: string,
            messages: readonly {
                readonly role: "user" | "assistant";
                readonly text: string;
                readonly images?: readonly {
                    readonly data: string;
                    readonly mimeType: NativeHistoryImage["mimeType"];
                }[];
            }[],
        ) => {
            sessionIds.add(sessionId);
            sessions.set(
                sessionId,
                messages.map((message) =>
                    message.role === "user"
                        ? {
                              role: "user",
                              text: message.text,
                              ...(message.images === undefined
                                  ? {}
                                  : {
                                        images: message.images.map((image, index) => ({
                                            ...image,
                                            name: `Image ${(index + 1).toString()}`,
                                        })),
                                    }),
                          }
                        : { role: "assistant", text: message.text, activities: [], content: [] },
                ),
            );
        },
    };
}

async function importAgentSession(
    cloud: Awaited<ReturnType<typeof createIdentityFixture>>,
    identity: Awaited<ReturnType<typeof createIdentity>>,
    botId: string,
    runtime: Awaited<ReturnType<typeof connectFakeRuntime>>,
    messages: readonly {
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly images?: readonly { readonly data: string; readonly mimeType: NativeHistoryImage["mimeType"] }[];
    }[],
): Promise<string> {
    const imported = await worker.fetch(
        new Request(`${cloud.origin}/morty/api/chat/projects/${identity.projectId}/bots/${botId}/access`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
            body: JSON.stringify({
                agentRef: "claude",
                configurations: [],
                conversationKey: crypto.randomUUID(),
                workspaceRef: "default",
            }),
        }),
        cloud.environment(cloud.origin),
    );
    expect(imported.status).toBe(200);
    const { sessionId } = v.parse(v.object({ sessionId: v.string() }), await imported.json());
    await runtime.seedNativeSession(sessionId, messages);
    return sessionId;
}

async function renderChat(identity: Awaited<ReturnType<typeof createIdentity>>, sessionId?: string) {
    const cloud = activeFixture();
    window.location.href = `${cloud.origin}/chat${sessionId === undefined ? "" : `?sessionId=${sessionId}`}`;
    const transport = new WebSocketApiTransport(cloud.origin);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={{
                            kind: "anonymous",
                            projectId: identity.projectId,
                            getToken: async () => identity.token,
                        }}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId={identity.userId}
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    return {
        container,
        close: async () => {
            transport.close();
            act(() => root.unmount());
            container.remove();
        },
    };
}

beforeAll(async () => {
    const origin = `http://127.0.0.1:${(await freePort()).toString()}`;
    fixture = await createIdentityFixture({
        appOrigin: origin,
        platformAllowedOrigins: new Set([origin]),
        workerEntryPoint: resolve(process.cwd(), "../worker/src/index.ts"),
        wranglerConfiguration: pathToFileURL(resolve(process.cwd(), "../../wrangler.jsonc")),
    });
}, 60_000);

afterAll(async () => {
    await fixture?.close();
});

test("Given an unpaired Bot, When Chat opens, Then the real Worker provides its pairing instruction", async () => {
    const identity = await createIdentity();
    const app = await renderChat(identity);
    try {
        const instruction = await waitForInput("Agent pairing instruction");
        expect(instruction.value).toMatch(/^follow http:\/\/127\.0\.0\.1:/u);
    } finally {
        await app.close();
    }
}, 30_000);

test("Given a workspace Bot, When the owner adds another Bot, Then Chat selects it", async () => {
    const identity = await createIdentity();
    const app = await renderChat(identity);
    try {
        const closePairing = await waitForButton("Close dialog");
        await act(async () => closePairing.click());
        const selector = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
            button.getAttribute("aria-label")?.startsWith("Select Bot."),
        );
        if (selector === undefined) {
            throw new Error("The Bot selector was not shown.");
        }
        const create = await act(async () => {
            selector.click();
            return await waitForButton("Create a new Bot");
        });
        const name = await act(async () => {
            create.click();
            return await waitForInput("Bot name");
        });
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(name, "Claude Bot");
            name.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const add = await waitForButton("Create Bot");
        await act(async () => {
            add.click();
            await waitForText("Claude Bot");
        });
        expect(
            [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
                button.getAttribute("aria-label")?.startsWith("Select Bot. Claude Bot,"),
            ),
        ).toBe(true);
    } finally {
        await app.close();
    }
}, 30_000);

test("Given a Bot paired with a fake daemon, When its owner sends a prompt, Then the reply appears in Chat", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId);
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const app = await renderChat(identity);
    try {
        await waitForMessageInput();
        const draft = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "Hello from the browser");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = await waitForEnabledSendButton();
        await act(async () => send.click());
        await waitForText("Claude Code turn 1: Hello from the browser");
        expect(document.querySelector('[role="log"]')?.textContent).toContain(
            "Claude Code turn 1: Hello from the browser",
        );
    } finally {
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 60_000);

test.each([
    "before the prompt",
    "after acceptance before the first delta",
    "after the first delta",
    "after the first delta and release",
] as const)(
    "Given a Bot Session, When another view joins %s, Then both show its prompt and live Agent output",
    async (joinTime) => {
        const identity = await createIdentity();
        const cloud = activeFixture();
        const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
        expect(bots.status).toBe(200);
        const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
        const botId = listing.bots[0]?.botId;
        if (botId === undefined) {
            throw new Error("The Project has no Bot.");
        }
        const runtime = await connectFakeRuntime(cloud, identity.projectId, {
            pausePrompt: joinTime === "after acceptance before the first delta" ? "before-delta" : "after-delta",
        });
        const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
            runtimeId: runtime.runtimeId,
            agentRef: "claude",
        });
        expect(configured.status).toBe(202);
        const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
            { role: "user", text: "Earlier prompt" },
            { role: "assistant", text: "Earlier reply" },
        ]);
        const first = await renderChat(identity, sessionId);
        const promptText =
            joinTime === "after acceptance before the first delta"
                ? "release before first delta"
                : joinTime === "after the first delta and release"
                  ? "release after first delta"
                  : "hold after first delta";
        let second: Awaited<ReturnType<typeof renderChat>> | null =
            joinTime === "before the prompt" ? await renderChat(identity, sessionId) : null;
        try {
            await waitForTextIn(first.container, "Earlier reply");
            if (second !== null) {
                await waitForTextIn(second.container, "Earlier reply");
            }
            const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
            if (draft === null) {
                throw new Error("The first message input was not shown.");
            }
            await act(async () => {
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
                setter?.call(draft, promptText);
                draft.dispatchEvent(new Event("input", { bubbles: true }));
            });
            const send = first.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
            if (send === null || send.disabled) {
                throw new Error("The first view cannot send a prompt.");
            }
            await act(async () => send.click());
            if (joinTime !== "after acceptance before the first delta") {
                await waitForTextIn(first.container, "Partial reply");
            } else {
                await runtime.promptGate.entered;
            }
            if (second === null) {
                second = await renderChat(identity, sessionId);
            }
            await Promise.all([
                waitForMessageIn(first.container, "Your message", promptText),
                waitForMessageIn(second.container, "Your message", promptText),
            ]);
            if (joinTime !== "after acceptance before the first delta") {
                await waitForTextIn(second.container, "Partial reply");
            }
            for (const [viewIndex, view] of [first, second].entries()) {
                const transcript = view.container.querySelector('[role="log"]');
                expect(
                    [...(transcript?.querySelectorAll('article[aria-label="Your message"]') ?? [])].filter((item) =>
                        item.textContent?.includes(promptText),
                    ),
                    `view ${(viewIndex + 1).toString()} should show the active prompt`,
                ).toHaveLength(1);
                if (joinTime !== "after acceptance before the first delta") {
                    expect(
                        [...(transcript?.querySelectorAll('article[aria-label="Agent response"]') ?? [])].filter(
                            (item) => item.textContent?.includes("Partial reply"),
                        ),
                    ).toHaveLength(1);
                    expect(transcript?.textContent).toContain("Partial reply");
                }
            }
            if (joinTime === "after acceptance before the first delta") {
                expect(second.container.querySelector('button[aria-label="Send message"]')).toBeNull();
                expect(second.container.querySelector('[role="log"]')?.textContent).not.toContain("Partial reply");
                runtime.promptGate.release();
                await waitForTextIn(second.container, "Claude Code turn 1: release before first delta");
            } else {
                expect(second.container.querySelector('button[aria-label="Send message"]')).toBeNull();
            }
            if (joinTime === "after the first delta and release") {
                runtime.promptGate.release();
                await waitForTextIn(second.container, "Partial reply and more");
                const responses = second.container.querySelectorAll('article[aria-label="Agent response"]');
                expect(
                    [...responses].filter((item) => item.textContent?.includes("Partial reply and more")),
                ).toHaveLength(1);
            }
            runtime.promptGate.release();
            const completedText =
                joinTime === "after acceptance before the first delta"
                    ? "Claude Code turn 1: release before first delta"
                    : "Partial reply and more";
            await Promise.all([
                waitForTextIn(first.container, completedText),
                waitForTextIn(second.container, completedText),
            ]);
        } finally {
            runtime.promptGate.release();
            await first.close();
            await second?.close();
            await runtime[Symbol.asyncDispose]();
        }
    },
    30_000,
);

test("Given a pending Agent permission, When a second browser joins the same Bot Session, Then it sees the request", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, { pausePrompt: "after-delta" });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, []);
    const first = await renderChat(identity, sessionId);
    let second: Awaited<ReturnType<typeof renderChat>> | null = null;
    try {
        await waitForMessageInput();
        const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The first message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "Ask for permission after first delta");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = await waitForEnabledSendButton();
        await act(async () => send.click());
        await waitForTextIn(first.container, "Partial reply");
        const commandId = runtime.activeCommandId();
        if (commandId === null) {
            throw new Error("The fake daemon did not accept the prompt.");
        }
        const permission: SessionPermissionRequestedEvent = {
            commandId,
            interactionId: "permission_one",
            kind: "session.permission.requested",
            options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-once" }],
            sessionId,
            title: "Allow reading this file?",
            toolCallId: "tool_one",
            toolKind: "read",
        };
        runtime.setActiveInteraction(permission);
        await runtime.publishSessionEvent(
            sessionId,
            encodeSessionPermissionRequestedEvent(permission),
            new AbortController().signal,
        );
        await waitForTextIn(first.container, permission.title);
        second = await renderChat(identity, sessionId);
        await waitForTextIn(second.container, "Ask for permission");
        await waitForTextIn(second.container, permission.title);
        expect(
            second.container.querySelector('[role="alertdialog"][aria-label="Agent permission request"]'),
        ).not.toBeNull();
        runtime.promptGate.release();
        await Promise.all([
            waitForTextIn(first.container, "Partial reply and more"),
            waitForTextIn(second.container, "Partial reply and more"),
        ]);
    } finally {
        runtime.promptGate.release();
        await first.close();
        await second?.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given an active Turn, When the browser reopens the Bot Session, Then it restores the partial reply before sending is allowed", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, { pausePrompt: "after-delta" });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "Earlier prompt" },
        { role: "assistant", text: "Earlier reply" },
    ]);
    const first = await renderChat(identity, sessionId);
    let firstOpen = true;
    let reopened: Awaited<ReturnType<typeof renderChat>> | null = null;
    try {
        await waitForTextIn(first.container, "Earlier reply");
        const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "hold after first delta");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = first.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
        if (send === null || send.disabled) {
            throw new Error("The first view cannot send a prompt.");
        }
        await act(async () => send.click());
        await waitForTextIn(first.container, "Partial reply");
        await first.close();
        firstOpen = false;
        reopened = await renderChat(identity, sessionId);
        await waitForTextIn(reopened.container, "Partial reply");
        expect(reopened.container.querySelector('button[aria-label="Send message"]')).toBeNull();
        runtime.promptGate.release();
        await waitForTextIn(reopened.container, "Partial reply and more");
    } finally {
        runtime.promptGate.release();
        await reopened?.close();
        if (firstOpen) {
            await first.close();
        }
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a Bot Session with loaded history, When the Runtime Turn snapshot is delayed, Then sending waits for the snapshot", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, { pauseActiveSnapshot: true });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "Earlier prompt" },
        { role: "assistant", text: "Earlier reply" },
    ]);
    const app = await renderChat(identity, sessionId);
    try {
        await runtime.activeSnapshotGate.entered;
        await waitForTextIn(app.container, "Earlier reply");
        const draft = app.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "Wait for Runtime state");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = app.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
        expect(send?.disabled).toBe(true);
        runtime.activeSnapshotGate.release();
        await waitForEnabledSendButton();
        expect(send?.disabled).toBe(false);
    } finally {
        runtime.activeSnapshotGate.release();
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a delayed Turn snapshot, When the Agent streams newer text, Then the joining browser receives the snapshot before the text", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, {
        pausePrompt: "after-delta",
        pauseAfterLastDelta: true,
    });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "Earlier prompt" },
        { role: "assistant", text: "Earlier reply" },
    ]);
    const first = await renderChat(identity, sessionId);
    let second: Awaited<ReturnType<typeof renderChat>> | null = null;
    try {
        await waitForTextIn(first.container, "Earlier reply");
        const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        const send = first.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
        if (draft === null || send === null) {
            throw new Error("The first view cannot send a prompt.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "hold after first delta");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        if (send.disabled) {
            throw new Error("The first view cannot send a prompt.");
        }
        await act(async () => send.click());
        await runtime.promptGate.entered;
        await waitForTextIn(first.container, "Partial reply");
        runtime.holdActiveSnapshot();
        second = await renderChat(identity, sessionId);
        await runtime.activeSnapshotGate.entered;
        runtime.promptGate.release();
        await runtime.lastDeltaGate.entered;
        await waitForTextIn(first.container, "Partial reply and more");
        expect(second.container.textContent).not.toContain("Partial reply and more");
        runtime.activeSnapshotGate.release();
        await waitForTextIn(second.container, "Partial reply and more");
        expect(
            [...second.container.querySelectorAll('article[aria-label="Agent response"]')].filter((item) =>
                item.textContent?.includes("Partial reply and more"),
            ),
        ).toHaveLength(1);
    } finally {
        runtime.promptGate.release();
        runtime.lastDeltaGate.release();
        runtime.activeSnapshotGate.release();
        await first.close();
        await second?.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a long active Turn, When another browser joins, Then both show the full output from Runtime memory", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, { pausePrompt: "after-last-delta" });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "Earlier prompt" },
        { role: "assistant", text: "Earlier reply" },
    ]);
    const first = await renderChat(identity, sessionId);
    let second: Awaited<ReturnType<typeof renderChat>> | null = null;
    try {
        await waitForTextIn(first.container, "Earlier reply");
        const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The first message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "hold after large output");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = first.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
        if (send === null || send.disabled) {
            throw new Error("The first view cannot send a prompt.");
        }
        await act(async () => send.click());
        await runtime.promptGate.entered;
        const output = `${"x".repeat(200_000)}END`;
        await waitForTextIn(first.container, "END");
        expect(
            [...first.container.querySelectorAll('article[aria-label="Agent response"]')].some((response) =>
                response.textContent?.includes(output),
            ),
        ).toBe(true);
        second = await renderChat(identity, sessionId);
        await waitForTextIn(second.container, output);
        for (const view of [first, second]) {
            const response = [...view.container.querySelectorAll('article[aria-label="Agent response"]')].find(
                (candidate) => candidate.textContent?.includes(output),
            );
            expect(response?.textContent).toContain(output);
            expect(response?.textContent).not.toContain("Earlier live output is unavailable");
        }
    } finally {
        runtime.promptGate.release();
        await first.close();
        await second?.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a long native Session, When Chat opens it through a fake daemon, Then loading, recent history, and truncation are visible", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId, {
        pauseHistory: "all",
        truncateHistory: true,
    });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(
        cloud,
        identity,
        botId,
        runtime,
        longHistory().map((message) => ({ role: message.role, text: message.text })),
    );
    const app = await renderChat(identity, sessionId);
    try {
        await waitForText("Loading conversation");
        runtime.historyGate.release();
        await waitForTextGone("Loading conversation");
        await waitForText("Recent answer");
        const transcript = document.querySelector<HTMLElement>('[role="log"]');
        if (transcript === null) {
            throw new Error("The transcript was not shown.");
        }
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "Question 1")).toBe(
            false,
        );
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "Question 77")).toBe(
            true,
        );
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "Question 1")).toBe(
            false,
        );
    } finally {
        runtime.historyGate.release();
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given more than two chunks of native history, When the reader reaches the top, Then older history appears without moving the reader", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId);
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(
        cloud,
        identity,
        botId,
        runtime,
        longHistory().map((message) => ({ role: message.role, text: message.text })),
    );
    const app = await renderChat(identity, sessionId);
    try {
        await waitForText("Recent answer");
        const transcript = app.container.querySelector<HTMLElement>('[role="log"]');
        if (transcript === null) {
            throw new Error("The transcript was not shown.");
        }
        const shows = (question: number) =>
            [...transcript.querySelectorAll('article[aria-label="Your message"]')].some(
                (item) => item.textContent === `Question ${question.toString()}`,
            );
        const loadMore = () => transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
        transcript.scrollTop = 0;
        await act(async () => loadMore());
        await waitForMessageIn(transcript, "Your message", "Question 1");
        expect(shows(1)).toBe(true);
        expect(shows(84)).toBe(true);
        expect(transcript.scrollTop).toBe(0);
    } finally {
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given two native Sessions, When the reader switches Sessions, Then the second transcript remains selected", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId);
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const firstSessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "First session prompt" },
        { role: "assistant", text: "First session answer" },
    ]);
    await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "Second session prompt" },
        { role: "assistant", text: "Second session answer" },
    ]);
    const app = await renderChat(identity, firstSessionId);
    try {
        await waitForText("First session answer");
        const second = await waitForButtonContaining("Second session prompt");
        await act(async () => {
            second.click();
            await waitForText("Second session answer");
        });
        const transcript = document.querySelector('[role="log"]');
        expect(transcript?.textContent).toContain("Second session answer");
        expect(transcript?.textContent).not.toContain("First session answer");
    } finally {
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a Bot Session with an image, When the page reloads during history recovery, Then sending waits and the image returns", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectFakeRuntime(cloud, identity.projectId);
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "claude",
    });
    expect(configured.status).toBe(202);
    const sessionId = await importAgentSession(cloud, identity, botId, runtime, [
        { role: "user", text: "What is in this image?", images: [{ data: "AQ==", mimeType: "image/png" }] },
        { role: "assistant", text: "A sample image" },
    ]);
    const firstPage = await renderChat(identity, sessionId);
    try {
        await waitForImage("Image 1");
        const selected = new URL(window.location.href).searchParams.get("sessionId");
        expect(selected).toBe(sessionId);
    } finally {
        await firstPage.close();
    }
    runtime.holdHistory(sessionId);
    const reloadedPage = await renderChat(identity, sessionId);
    try {
        await waitForText("Loading conversation");
        const draft = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The message input was not shown.");
        }
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(draft, "Duplicate prompt");
            draft.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
        expect(send?.disabled).toBe(true);
        runtime.historyGate.release();
        const image = await waitForImage("Image 1");
        expect(image.getAttribute("src")).toBe("data:image/png;base64,AQ==");
    } finally {
        runtime.historyGate.release();
        await reloadedPage.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);
