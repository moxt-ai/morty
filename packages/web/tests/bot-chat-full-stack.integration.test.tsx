import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeHistoryMessage } from "@moxt-ai/mobius-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
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
        close: async () => {
            await act(async () => root.unmount());
            transport.close();
            document.body.replaceChildren();
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

test("Given a long native Session behind the real Platform, When Chat opens it, Then recent history and manual reveal are visible", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const historyRequested = Promise.withResolvers<void>();
    const releaseHistory = Promise.withResolvers<void>();
    const runtime = await cloud.connectAgent(identity.projectId, {
        agentId: "codex",
        loadNativeHistory: async (_sessionId, signal) => {
            historyRequested.resolve();
            await releaseHistory.promise;
            signal.throwIfAborted();
            return {
                status: "available",
                messages: longHistory(),
                truncated: true,
                coveredCommandIds: [],
                coveredMessageIds: [],
            };
        },
    });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "codex",
    });
    expect(configured.status).toBe(202);
    const app = await renderChat(identity);
    try {
        await waitForMessageInput();
        const newConversation = await waitForButton("New conversation");
        await act(async () => newConversation.click());
        await historyRequested.promise;
        await waitForText("Loading conversation");
        releaseHistory.resolve();
        await waitForText("Recent answer");
        const transcript = document.querySelector<HTMLElement>('[role="log"]');
        if (transcript === null) {
            throw new Error("The transcript was not shown.");
        }
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 1")).toBe(
            false,
        );
        expect(transcript.textContent).toContain("Older messages are unavailable");
        const more = await waitForButton("Load more");
        transcript.scrollTop = 120;
        await act(async () => more.click());
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 1")).toBe(
            false,
        );
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 6")).toBe(
            true,
        );
        expect(transcript.scrollTop).toBe(120);
        await act(async () => more.click());
        expect([...transcript.querySelectorAll("article")].some((item) => item.textContent === "YouQuestion 1")).toBe(
            true,
        );
        expect(transcript.scrollTop).toBe(120);
    } finally {
        releaseHistory.resolve();
        await app.close();
    }
}, 30_000);

test("Given two Bot Sessions, When an older history response arrives late, Then the selected transcript stays on the newer Session", async () => {
    const identity = await createIdentity();
    const cloud = activeFixture();
    const bots = await chatRequest(identity, `projects/${identity.projectId}/management/bots`);
    expect(bots.status).toBe(200);
    const listing = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const botId = listing.bots[0]?.botId;
    if (botId === undefined) {
        throw new Error("The Project has no Bot.");
    }
    const firstRequested = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let historyCount = 0;
    const runtime = await cloud.connectAgent(identity.projectId, {
        agentId: "codex",
        loadNativeHistory: async (_sessionId, signal) => {
            historyCount += 1;
            const current = historyCount;
            if (current === 1) {
                firstRequested.resolve();
                await releaseFirst.promise;
            }
            signal.throwIfAborted();
            return {
                status: "available",
                messages: [{ role: "user", text: current === 1 ? "First session prompt" : "Second session prompt" }],
                truncated: false,
                coveredCommandIds: [],
                coveredMessageIds: [],
            };
        },
    });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "codex",
    });
    expect(configured.status).toBe(202);
    const app = await renderChat(identity);
    try {
        await waitForMessageInput();
        const newConversation = await waitForButton("New conversation");
        await act(async () => newConversation.click());
        await firstRequested.promise;
        await act(async () => newConversation.click());
        await waitForText("Second session prompt");
        const transcript = document.querySelector('[role="log"]');
        expect(transcript?.textContent).toContain("Second session prompt");
        releaseFirst.resolve();
        await waitForText("First session prompt");
        expect(transcript?.textContent).toContain("Second session prompt");
        expect(transcript?.textContent).not.toContain("First session prompt");
    } finally {
        releaseFirst.resolve();
        await app.close();
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
    const reloadRequested = Promise.withResolvers<void>();
    const releaseReload = Promise.withResolvers<void>();
    let historyCount = 0;
    const runtime = await cloud.connectAgent(identity.projectId, {
        agentId: "codex",
        loadNativeHistory: async (_sessionId, signal) => {
            historyCount += 1;
            if (historyCount === 2) {
                reloadRequested.resolve();
                await releaseReload.promise;
            }
            signal.throwIfAborted();
            return {
                status: "available",
                messages: [
                    {
                        role: "user",
                        text: "What is in this image?",
                        images: [{ data: "AQ==", mimeType: "image/png", name: "sample.png" }],
                    },
                ],
                truncated: false,
                coveredCommandIds: [],
                coveredMessageIds: [],
            };
        },
    });
    const configured = await chatRequest(identity, `chat/projects/${identity.projectId}/bots/${botId}/setup`, {
        runtimeId: runtime.runtimeId,
        agentRef: "codex",
    });
    expect(configured.status).toBe(202);
    const firstPage = await renderChat(identity);
    let sessionId: string;
    try {
        await waitForMessageInput();
        const newConversation = await waitForButton("New conversation");
        await act(async () => newConversation.click());
        await waitForImage("sample.png");
        const selected = new URL(window.location.href).searchParams.get("sessionId");
        if (selected === null) {
            throw new Error("The Bot Session was not selected in the URL.");
        }
        sessionId = selected;
    } finally {
        await firstPage.close();
    }
    const reloadedPage = await renderChat(identity, sessionId);
    try {
        await reloadRequested.promise;
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
        releaseReload.resolve();
        const image = await waitForImage("sample.png");
        expect(image.getAttribute("src")).toBe("data:image/png;base64,AQ==");
        expect(send?.disabled).toBe(false);
    } finally {
        releaseReload.resolve();
        await reloadedPage.close();
    }
}, 30_000);
