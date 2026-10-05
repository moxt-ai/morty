import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";

let runtime: Miniflare;

beforeAll(async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        loader: { ".txt": "text", ".sql": "text" },
        platform: "browser",
        target: "es2022",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Missing Worker bundle");
    }
    runtime = new Miniflare(
        convertV4MiniflareOptions({
            bindings: {
                APP_ORIGIN: "https://chat.test",
                CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----\ntest",
                CLERK_PUBLISHABLE_KEY: "pk_test_browser",
            },
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            modules: true,
            script: output.text,
        }),
    );
    await runtime.ready;
});

afterAll(async () => runtime.dispose());

type MiniflareWebSocket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;

function receive(socket: MiniflareWebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const close = () => reject(new Error("The WebSocket closed before replying."));
        socket.addEventListener("close", close, { once: true });
        socket.addEventListener(
            "message",
            (event) => {
                socket.removeEventListener("close", close);
                resolve(JSON.parse(String(event.data)) as unknown);
            },
            { once: true },
        );
    });
}

function receiveResponse(socket: MiniflareWebSocket, requestId: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const frames: unknown[] = [];
        let done = false;
        const close = () => reject(new Error("The WebSocket closed before replying."));
        socket.addEventListener("close", close, { once: true });
        socket.addEventListener("message", (event) => {
            if (done) {
                return;
            }
            const frame: unknown = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            frames.push(frame);
            if (
                typeof frame === "object" &&
                frame !== null &&
                Reflect.get(frame, "kind") === "response.end" &&
                Reflect.get(frame, "requestId") === requestId
            ) {
                done = true;
                socket.removeEventListener("close", close);
                resolve(frames);
            }
        });
    });
}

function decodeChunk(value: unknown): { readonly requestId: string; readonly body: string } {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value as Uint8Array);
    const requestIdLength = bytes[0] ?? 0;
    return {
        requestId: new TextDecoder().decode(bytes.subarray(1, 1 + requestIdLength)),
        body: new TextDecoder().decode(bytes.subarray(1 + requestIdLength)),
    };
}

test("Given a public HTTP client, When it requests browser-only APIs, Then Chat does not expose the endpoints", async () => {
    const [cloudResponse, projectResponse] = await Promise.all([
        runtime.dispatchFetch("https://chat.test/morty/api/config"),
        runtime.dispatchFetch("https://chat.test/morty/api/projects/prj_test/management/bots/bot_test"),
    ]);

    for (const response of [cloudResponse, projectResponse]) {
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    }
});

test("Given browsers with different empty-body representations, When the Chat web application uses the WebSocket bridge, Then API requests pass and document requests are rejected", async () => {
    const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
        headers: { Origin: "https://chat.test", Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    socket.accept();
    const reply = receiveResponse(socket, "request-1");
    socket.send(
        JSON.stringify({
            kind: "request",
            requestId: "request-1",
            method: "GET",
            path: "/morty/api/config",
            headers: [],
            body: "",
        }),
    );
    const frames = await reply;
    const begin = frames[0];
    const end = frames.at(-1);
    expect(begin).toMatchObject({ kind: "response.begin", requestId: "request-1", status: 200 });
    const chunks = frames.slice(1, -1).map(decodeChunk);
    expect(chunks.every((chunk) => chunk.requestId === "request-1")).toBe(true);
    expect(chunks.map((chunk) => chunk.body).join("")).toBe(JSON.stringify({ publishableKey: "pk_test_browser" }));
    expect(end).toEqual({ kind: "response.end", requestId: "request-1" });
    const rejected = receive(socket);
    socket.send(
        JSON.stringify({
            kind: "request",
            requestId: "request-2",
            method: "GET",
            path: "/pair.md?token=secret",
            headers: [],
            body: null,
        }),
    );
    await expect(rejected).resolves.toEqual({
        kind: "error",
        requestId: "request-2",
        code: "INVALID_BRIDGE_REQUEST",
        message: "The bridged request is invalid.",
    });
    socket.close(1000, "Test complete");
});
