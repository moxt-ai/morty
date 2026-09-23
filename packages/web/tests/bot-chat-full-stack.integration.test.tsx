import { unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeHistoryMessage } from "@moxt-ai/mobius-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestLocalRuntime } from "../../../third-party/mobius/tests/infra/platform-real-runtime.ts";
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

async function connectRealRuntime(cloud: Awaited<ReturnType<typeof createIdentityFixture>>, projectId: string) {
    return await createTestLocalRuntime({
        credential: cloud.baseConfiguration.MOBIUS_APP_SECRET,
        fakeAgentPath: resolve(
            process.cwd(),
            "../../third-party/mobius/tests/agent-daemon/fixtures/fake-acp-agent/src/cli.ts",
        ),
        origin: cloud.baseConfiguration.MOBIUS_BASE_URL,
        projectId,
        request: cloud.platformRequest,
        signal: AbortSignal.timeout(60_000),
    });
}

async function importAgentSession(
    cloud: Awaited<ReturnType<typeof createIdentityFixture>>,
    identity: Awaited<ReturnType<typeof createIdentity>>,
    botId: string,
    runtime: Awaited<ReturnType<typeof createTestLocalRuntime>>,
    messages: readonly {
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
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

test("Given a Bot paired with a real local Runtime, When its owner sends a prompt, Then the fake ACP Agent reply appears in Chat", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectRealRuntime(cloud, identity.projectId);
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

test("Given two open views of one Bot Session, When one sends a prompt, Then both show its prompt and live Agent output", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectRealRuntime(cloud, identity.projectId);
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
    await waitForTextIn(first.container, "Earlier reply");
    const second = await renderChat(identity, sessionId);
    try {
        await waitForTextIn(second.container, "Earlier reply");
        const draft = first.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (draft === null) {
            throw new Error("The first message input was not shown.");
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
        await waitForTextIn(second.container, "hold after first delta");
        await waitForTextIn(second.container, "Partial reply");
        for (const view of [first, second]) {
            const transcript = view.container.querySelector('[role="log"]');
            expect(
                [...(transcript?.querySelectorAll('article[aria-label="Message from you"]') ?? [])].filter((item) =>
                    item.textContent?.includes("hold after first delta"),
                ),
            ).toHaveLength(1);
            expect(transcript?.querySelectorAll('article[aria-label="Current Agent response"]')).toHaveLength(1);
            expect(transcript?.textContent).toContain("Partial reply");
        }
        expect(second.container.querySelector('button[aria-label="Send message"]')).toBeNull();
    } finally {
        await first.close();
        await second.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);

test("Given a long native ACP Session, When Chat opens it through the real Runtime, Then loading, recent history, and truncation are visible", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const runtime = await connectRealRuntime(cloud, identity.projectId);
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
    await writeFile(resolve(runtime.stateDirectory, "agent/pause-load"), "*");
    const app = await renderChat(identity, sessionId);
    try {
        await waitForText("Loading conversation");
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load"));
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
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load")).catch(() => undefined);
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
    const runtime = await connectRealRuntime(cloud, identity.projectId);
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
    await writeFile(resolve(runtime.stateDirectory, "agent/pause-load"), firstSessionId);
    const app = await renderChat(identity, firstSessionId);
    try {
        await waitForText("Loading conversation");
        const second = await waitForButton("Second session prompt");
        await act(async () => second.click());
        await waitForText("Second session answer");
        const transcript = document.querySelector('[role="log"]');
        expect(transcript?.textContent).toContain("Second session answer");
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load"));
        expect(transcript?.textContent).not.toContain("First session answer");
    } finally {
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load")).catch(() => undefined);
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
    const runtime = await connectRealRuntime(cloud, identity.projectId);
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
    await writeFile(resolve(runtime.stateDirectory, "agent/pause-load"), "*");
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
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load"));
        const image = await waitForImage("Image 1");
        expect(image.getAttribute("src")).toBe("data:image/png;base64,AQ==");
        expect(send?.disabled).toBe(false);
    } finally {
        await unlink(resolve(runtime.stateDirectory, "agent/pause-load")).catch(() => undefined);
        await reloadedPage.close();
        await runtime[Symbol.asyncDispose]();
    }
}, 30_000);
