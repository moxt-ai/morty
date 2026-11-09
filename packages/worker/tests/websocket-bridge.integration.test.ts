import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MAX_BRIDGE_SUBSCRIPTIONS, MAX_BRIDGE_UPLOAD_BYTES } from "../src/infra/websocket-api-bridge.ts";

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
        runtime.dispatchFetch("https://chat.test/morty/api/accounts/prj_test/management/bots/bot_test"),
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

/** Collects every frame, so a scenario can await the one it expects regardless of arrival order. */
function frames(socket: MiniflareWebSocket): (kind: string, id: string) => Promise<unknown> {
    const received: unknown[] = [];
    const waiters: { readonly match: (frame: unknown) => boolean; readonly resolve: (frame: unknown) => void }[] = [];
    const matcher = (kind: string, id: string) => (frame: unknown) =>
        v.is(v.object({ kind: v.literal(kind) }), frame) &&
        (v.is(v.object({ subscriptionId: v.literal(id) }), frame) ||
            v.is(v.object({ requestId: v.literal(id) }), frame));
    socket.addEventListener("message", (event) => {
        const frame: unknown = JSON.parse(String(event.data));
        const waiter = waiters.findIndex((entry) => entry.match(frame));
        if (waiter === -1) {
            received.push(frame);
        } else {
            waiters.splice(waiter, 1)[0]?.resolve(frame);
        }
    });
    return (kind, id) => {
        const match = matcher(kind, id);
        const index = received.findIndex(match);
        if (index !== -1) {
            return Promise.resolve(received.splice(index, 1)[0]);
        }
        return new Promise((resolve) => waiters.push({ match, resolve }));
    };
}

async function openBridge(): Promise<MiniflareWebSocket> {
    const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
        headers: { Origin: "https://chat.test", Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (response.status !== 101 || socket === null) {
        throw new Error("Expected the Chat WebSocket bridge.");
    }
    socket.accept();
    return socket;
}

test("Given a watch the API refuses, When its first sample is unauthorized, Then the bridge reports the refusal and ends the watch instead of repeating it", async () => {
    const socket = await openBridge();
    const next = frames(socket);
    socket.send(
        JSON.stringify({
            kind: "watch",
            subscriptionId: "unauthorized-watch",
            method: "GET",
            path: "/morty/api/identity/devices",
            headers: [],
            body: null,
        }),
    );
    await expect(next("watch.ready", "unauthorized-watch")).resolves.toMatchObject({ status: 401 });
    await expect(next("subscription.end", "unauthorized-watch")).resolves.toEqual({
        kind: "subscription.end",
        subscriptionId: "unauthorized-watch",
    });
    socket.close(1000, "Test complete");
});

test("Given a connection holding its subscription and upload capacity, When it opens more, Then each excess is refused and the connection keeps serving", async () => {
    const socket = await openBridge();
    const next = frames(socket);
    const watch = (subscriptionId: string) =>
        socket.send(
            JSON.stringify({
                kind: "watch",
                subscriptionId,
                method: "POST",
                path: "/morty/api/missing/workspace",
                headers: [],
                body: null,
            }),
        );
    for (let index = 0; index < MAX_BRIDGE_SUBSCRIPTIONS; index += 1) {
        watch(`watch-${index}`);
        await next("watch.ready", `watch-${index}`);
    }
    watch("watch-excess");
    await expect(next("error", "watch-excess")).resolves.toMatchObject({ code: "BRIDGE_CAPACITY_EXCEEDED" });

    const upload = (requestId: string, bodyByteLength: number) =>
        socket.send(
            JSON.stringify({
                kind: "request",
                requestId,
                method: "POST",
                path: "/morty/api/missing/upload",
                headers: [],
                body: null,
                bodyByteLength,
            }),
        );
    const uploadBytes = 3 * 1_024 * 1_024;
    for (let index = 0; index < MAX_BRIDGE_UPLOAD_BYTES / uploadBytes; index += 1) {
        upload(`upload-${index}`, uploadBytes);
    }
    upload("upload-excess", 1);
    await expect(next("error", "upload-excess")).resolves.toMatchObject({ code: "BRIDGE_CAPACITY_EXCEEDED" });

    socket.send(JSON.stringify({ kind: "diagnostic.ping", requestId: "still-serving" }));
    await expect(next("diagnostic.pong", "still-serving")).resolves.toEqual({
        kind: "diagnostic.pong",
        requestId: "still-serving",
    });
    socket.close(1000, "Test complete");
});

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
