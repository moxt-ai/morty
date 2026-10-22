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
                resolve(JSON.parse(String(event.data)));
            },
            { once: true },
        );
    });
}

test("Given a public HTTP client, When it requests browser-only APIs, Then Chat does not expose the endpoints", async () => {
    const [identityResponse, projectResponse] = await Promise.all([
        runtime.dispatchFetch("https://chat.test/morty/api/identity/transfers"),
        runtime.dispatchFetch("https://chat.test/morty/api/projects/prj_test/management/bots/bot_test"),
    ]);

    for (const response of [identityResponse, projectResponse]) {
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    }
});

test("Given a browser API request, When the Chat web application uses the WebSocket bridge, Then the response is readable JSON text and document requests are rejected", async () => {
    const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
        headers: { Origin: "https://chat.test", Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    socket.accept();
    const reply = receive(socket);
    socket.send(
        JSON.stringify({
            kind: "request",
            requestId: "request-1",
            method: "POST",
            path: "/morty/api/identity/transfers",
            headers: [],
            body: null,
        }),
    );
    await expect(reply).resolves.toMatchObject({
        kind: "response",
        requestId: "request-1",
        status: 401,
        body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Anonymous identity is required." } }),
    });
    const rejected = receive(socket);
    socket.send(
        JSON.stringify({
            kind: "request",
            requestId: "request-2",
            method: "GET",
            path: "/setup.md?token=secret",
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
