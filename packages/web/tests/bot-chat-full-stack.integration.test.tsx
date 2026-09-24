import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeHistoryImage, NativeHistoryMessage, NativeSessionHistory } from "@moxt-ai/mobius-protocol";
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
                (button) => button.textContent?.trim() === label,
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
                (input) => input.getAttribute("aria-label") === label,
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
        readonly pausePrompt?: "before-delta" | "after-delta";
        readonly truncateHistory?: boolean;
    } = {},
) {
    const sessions = new Map<string, readonly NativeHistoryMessage[]>();
    const sessionIds = new Set<string>();
    let pausedHistory = options.pauseHistory;
    const historyGate = pauseGate();
    const promptGate = pauseGate();
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
        afterSessionStarted: async (_command, signal) => {
            if (options.pausePrompt === "before-delta") {
                await promptGate.wait(signal);
            }
        },
        afterFirstDelta: async (_command, signal) => {
            if (options.pausePrompt === "after-delta") {
                await promptGate.wait(signal);
            }
        },
        responseParts: (command, turn) =>
            command.prompt.includes("after first delta")
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
        promptGate,
        holdHistory: (sessionId: string) => {
            pausedHistory = sessionId;
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
    const sessionId = crypto.randomUUID();
    await runtime.seedNativeSession(sessionId, messages);
    const imported = await worker.fetch(
        new Request(
            `${cloud.origin}/morty/api/chat/projects/${identity.projectId}/bots/${botId}/local-sessions/create`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                body: JSON.stringify({ action: "import", sessionId }),
            },
        ),
        cloud.environment(cloud.origin),
    );
    expect(imported.status).toBe(200);
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
            await act(async () => root.unmount());
            transport.close();
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
        const button = await waitForButton("Pair Agent");
        await act(async () => button.click());
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
        const name = await waitForInput("New Bot name");
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(name, "Claude Bot");
            name.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const add = await waitForButton("Add Bot");
        await act(async () => add.click());
        await waitForText("Claude Bot");
        expect(document.querySelector("h1")?.textContent).toBe("Claude Bot");
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
            await waitForTextIn(second.container, promptText);
            if (joinTime !== "after acceptance before the first delta") {
                await waitForTextIn(second.container, "Partial reply");
            }
            for (const view of [first, second]) {
                const transcript = view.container.querySelector('[role="log"]');
                expect(
                    [...(transcript?.querySelectorAll('article[aria-label="Message from you"]') ?? [])].filter((item) =>
                        item.textContent?.includes(promptText),
                    ),
                ).toHaveLength(1);
                if (joinTime !== "after acceptance before the first delta") {
                    expect(transcript?.querySelectorAll('article[aria-label="Current Agent response"]')).toHaveLength(
                        1,
                    );
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
                const responses = second.container.querySelectorAll(
                    'article[aria-label="Current Agent response"], article[aria-label="Agent response"]',
                );
                expect(
                    [...responses].filter((item) => item.textContent?.includes("Partial reply and more")),
                ).toHaveLength(1);
            }
        } finally {
            runtime.promptGate.release();
            await first.close();
            await second?.close();
            await runtime[Symbol.asyncDispose]();
        }
    },
    30_000,
);

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
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 1")).toBe(
            false,
        );
        expect(transcript.textContent).toContain("Older messages are unavailable");
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 77")).toBe(
            true,
        );
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 1")).toBe(
            false,
        );
    } finally {
        runtime.historyGate.release();
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given more than two chunks of native history, When the reader clicks Load more, Then one older chunk appears without moving the reader", async () => {
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
            [...transcript.querySelectorAll('article[aria-label="Message from you"]')].some(
                (item) => item.textContent === `YouQuestion ${question.toString()}`,
            );
        const loadMore = () => transcript.querySelector<HTMLButtonElement>("button")?.click();
        transcript.scrollTop = 125;
        expect(shows(46)).toBe(true);
        expect(shows(45)).toBe(false);
        await act(async () => loadMore());
        expect(shows(6)).toBe(true);
        expect(shows(5)).toBe(false);
        expect(transcript.scrollTop).toBe(125);
        await act(async () => loadMore());
        expect(shows(1)).toBe(true);
        expect(transcript.scrollTop).toBe(125);
        expect(transcript.querySelector("button")?.textContent).not.toBe("Load more");
    } finally {
        await app.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given two native Sessions, When the reader switches while the first history is paused, Then the second transcript remains selected", async () => {
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
    runtime.holdHistory(firstSessionId);
    const app = await renderChat(identity, firstSessionId);
    try {
        await waitForText("Loading conversation");
        const second = await waitForButton("Second session prompt");
        await act(async () => second.click());
        await waitForText("Second session answer");
        const transcript = document.querySelector('[role="log"]');
        expect(transcript?.textContent).toContain("Second session answer");
        runtime.historyGate.release();
        expect(transcript?.textContent).not.toContain("First session answer");
    } finally {
        runtime.historyGate.release();
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
        await waitForEnabledSendButton();
        expect(send?.disabled).toBe(false);
    } finally {
        runtime.historyGate.release();
        await reloadedPage.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);
