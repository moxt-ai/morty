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
            durableObjects: { CHAT_WEBSOCKETS: { className: "ChatWebSocketDurableObject", useSQLite: true } },
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

test("Given a browser connection, When it sends fixed connection heartbeats between API calls, Then it receives acknowledgements and can still use the bridge", async () => {
    const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
        headers: { Origin: "https://chat.test", Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    socket.accept();
    try {
        const heartbeat = receive(socket);
        socket.send('{"kind":"ping"}');
        await expect(heartbeat).resolves.toEqual({ kind: "pong" });
        const reply = receive(socket);
        socket.send(JSON.stringify({ kind: "diagnostic.ping", requestId: "latency-after-heartbeat" }));
        await expect(reply).resolves.toEqual({ kind: "diagnostic.pong", requestId: "latency-after-heartbeat" });
    } finally {
        socket.close();
    }
});

test.each([
    {
        name: "missing upgrade",
        headers: new Headers({ Origin: "https://chat.test" }),
        status: 426,
        code: "WEBSOCKET_UPGRADE_REQUIRED",
    },
    {
        name: "foreign origin",
        headers: new Headers({ Origin: "https://other.test", Upgrade: "websocket" }),
        status: 403,
        code: "WEBSOCKET_ORIGIN_FORBIDDEN",
    },
    {
        name: "missing origin",
        headers: new Headers({ Upgrade: "websocket" }),
        status: 403,
        code: "WEBSOCKET_ORIGIN_FORBIDDEN",
    },
])(
    "Given a $name handshake rejection, When it crosses the public Worker to DO boundary, Then the HTTP status and error code are preserved",
    async ({ headers, status, code }) => {
        const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
            headers: Object.fromEntries(headers),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
);

test("Given browser API requests and watches, When the Chat web application uses the WebSocket bridge, Then responses and watch snapshots preserve JSON errors and document requests are rejected", async () => {
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
    const watched = receive(socket);
    socket.send(
        JSON.stringify({
            kind: "watch",
            subscriptionId: "watch-1",
            method: "POST",
            path: "/morty/api/missing/workspace",
            headers: [],
            body: null,
        }),
    );
    await expect(watched).resolves.toMatchObject({
        kind: "watch.ready",
        subscriptionId: "watch-1",
        status: 404,
        body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }),
    });
    socket.close(1000, "Test complete");
});
