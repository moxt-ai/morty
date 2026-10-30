import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";

test("Given exhausted creation quota over HTTP, When the same visitor reconnects through WebSocket, Then the quota still applies and frame headers cannot forge a different visitor", async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: ["node:*", "cloudflare:*"],
        loader: { ".txt": "text", ".sql": "text" },
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Missing Worker bundle");
    }
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            workers: [
                {
                    name: "morty",
                    modules: true,
                    script: output.text,
                    compatibilityDate: "2026-09-07",
                    compatibilityFlags: ["nodejs_compat"],
                    bindings: { APP_ORIGIN: "https://chat.test" },
                    durableObjects: { CHAT_WEBSOCKETS: { className: "ChatWebSocketDurableObject", useSQLite: true } },
                    serviceBindings: { ANONYMOUS_CREATION_LIMITER: "creation-budget" },
                },
                {
                    name: "creation-budget",
                    modules: true,
                    compatibilityDate: "2026-09-07",
                    // Stateful external admission port; each independent visitor has one attempt. No clock is involved.
                    script: `import { WorkerEntrypoint } from "cloudflare:workers";
const visitors = new Set();
export default class extends WorkerEntrypoint {
    limit({key}) { const success = !visitors.has(key); visitors.add(key); return {success}; }
}`,
                },
            ],
        }),
    );
    const creationKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const body = JSON.stringify({ creationKey });
    try {
        // An upstream configuration failure still consumes admission, without needing to create disposable Projects.
        const first = await runtime.dispatchFetch("https://chat.test/morty/api/identity/anonymous-users", {
            method: "POST",
            headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
            body,
        });
        expect(first.status).toBe(503);
        expect(await first.json()).toMatchObject({ error: { code: "PLATFORM_UNAVAILABLE" } });
        for (const address of ["192.0.2.10", "192.0.2.10", "192.0.2.11"]) {
            const response = await runtime.dispatchFetch("https://chat.test/morty/ws", {
                headers: { Upgrade: "websocket", Origin: "https://chat.test", "CF-Connecting-IP": address },
            });
            const socket = response.webSocket;
            if (socket === null) {
                throw new Error("Missing WebSocket");
            }
            socket.accept();
            const request = (headers: readonly (readonly [string, string])[]) => {
                const reply = new Promise<unknown>((resolve) => {
                    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
                        once: true,
                    });
                });
                socket.send(
                    JSON.stringify({
                        kind: "request",
                        requestId: "creation",
                        method: "POST",
                        path: "/morty/api/identity/anonymous-users",
                        headers,
                        body,
                    }),
                );
                return reply;
            };
            try {
                const reply = await request([["content-type", "application/json"]]);
                expect(reply).toMatchObject({ kind: "response", status: address === "192.0.2.10" ? 429 : 503 });
                if (address === "192.0.2.10") {
                    expect(reply).toMatchObject({
                        body: JSON.stringify({
                            error: {
                                code: "IDENTITY_CREATION_RATE_LIMITED",
                                message: "Too many new connections. Wait a minute and try again.",
                            },
                        }),
                    });
                }
                expect(
                    await request([
                        ["content-type", "application/json"],
                        ["CF-Connecting-IP", "192.0.2.20"],
                    ]),
                ).toMatchObject({ kind: "error", code: "INVALID_BRIDGE_REQUEST" });
            } finally {
                socket.close();
            }
        }
    } finally {
        await runtime.dispose();
    }
});
