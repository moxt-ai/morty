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
        loader: { ".md": "text", ".sql": "text" },
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

test("Given the Chat web application, When it uses the WebSocket bridge, Then API requests pass and document requests are rejected", async () => {
    const response = await runtime.dispatchFetch("https://chat.test/mobius-cloud/ws", {
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
            method: "GET",
            path: "/mobius-cloud/api/config",
            headers: [],
            body: null,
        }),
    );
    await expect(reply).resolves.toMatchObject({
        kind: "response",
        requestId: "request-1",
        status: 200,
        body: JSON.stringify({ publishableKey: "pk_test_browser" }),
    });
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
