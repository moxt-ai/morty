import { createHash } from "node:crypto";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
    CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS,
    ChatBridgeError,
    WebSocketApiTransport,
} from "../src/services/api/websocket-api-transport.ts";
import { TestClock } from "./infra/test-clock.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface BridgeEndpoint {
    readonly origin: string;
    /** How many TCP upgrades the endpoint saw. */
    readonly accepted: () => number;
    /** Resolves once the endpoint has accepted at least this many upgrades. */
    readonly waitForAccepted: (count: number) => Promise<void>;
    readonly close: () => Promise<void>;
}

/**
 * A real WebSocket endpoint in front of the bridge. `stalls` keeps the upgrade
 * pending, which is what a network that accepts the connection but never answers
 * looks like; `completesUpgrade` answers the handshake and opens the socket.
 */
async function bridgeEndpoint(options: { readonly upgradeAfter: number }): Promise<BridgeEndpoint> {
    const sockets = new Set<Socket>();
    const observers: (() => void)[] = [];
    let accepted = 0;
    const server: Server = createServer((socket) => {
        accepted += 1;
        for (const observer of observers.splice(0)) {
            observer();
        }
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => sockets.delete(socket));
        if (accepted <= options.upgradeAfter) {
            return;
        }
        let request = "";
        socket.on("data", (chunk: Buffer) => {
            request += chunk.toString("utf8");
            const key = /sec-websocket-key:\s*(.+)\r\n/iu.exec(request)?.[1]?.trim();
            if (key === undefined) {
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                [
                    "HTTP/1.1 101 Switching Protocols",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    `Sec-WebSocket-Accept: ${accept}`,
                    "",
                    "",
                ].join("\r\n"),
            );
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a stalled bridge port");
    }
    const { port } = address;
    const reached = (count: number): boolean => accepted >= count;
    return {
        origin: `http://127.0.0.1:${port}`,
        accepted: () => accepted,
        waitForAccepted: async (count) => {
            while (!reached(count)) {
                await new Promise<void>((resolve) => {
                    observers.push(resolve);
                });
            }
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

let endpoint: BridgeEndpoint | null = null;
afterEach(async () => {
    await endpoint?.close();
    endpoint = null;
});

/** Yields until the transport arms its next deadline or backoff. */
async function waitForArmedTimer(clock: TestClock): Promise<void> {
    for (let drained = 0; drained < 100 && clock.pendingSleeps() === 0; drained += 1) {
        await Promise.resolve();
    }
}

/**
 * Boundary contract for the transport: a stalled upgrade must outlive neither
 * the attempt nor the budget. The retry keeps dialing, so the bridge reconnects
 * on its own once the network answers again instead of pinning "connecting".
 */
test("Given a handshake that outlasts the next backoff, When the network answers again, Then the bridge reconnects on its own", {
    timeout: 30_000,
}, async () => {
    // The first upgrade stalls forever; every later one completes.
    endpoint = await bridgeEndpoint({ upgradeAfter: 1 });
    const clock = new TestClock(CLOCK_ORIGIN);
    const transport = new WebSocketApiTransport(endpoint.origin, clock);
    transport.open();
    transport.disconnect();

    clock.advanceBy(RECONNECT_DELAYS_MILLISECONDS[0] ?? 1_000);
    await endpoint.waitForAccepted(1);
    // The attempt is waiting on the stalled handshake and holds its own
    // deadline instead of leaving the bridge pinned with no timer at all.
    expect(clock.pendingSleeps()).toBeGreaterThan(0);

    // The handshake deadline expires well after the next backoff would have
    // been due, and the transport gives up on that socket.
    clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
    await waitForArmedTimer(clock);
    expect(clock.pendingSleeps()).toBeGreaterThan(0);

    clock.advanceBy(RECONNECT_DELAYS_MILLISECONDS[1] ?? 2_000);
    // The second attempt upgrades, so the bridge returns on its own.
    await expect(transport.waitForBridge(AbortSignal.timeout(5_000))).resolves.toBeUndefined();
    expect(endpoint.accepted()).toBe(2);
    transport.dispose();
});

/**
 * Boundary contract for the transport: the budget is bounded even when every
 * upgrade stalls, so callers waiting for the bridge are told instead of waiting
 * forever, and an explicit retry can still dial.
 */
test("Given a bridge whose handshake never completes, When the retry budget is consumed, Then waiting callers are told instead of waiting forever", {
    timeout: 30_000,
}, async () => {
    endpoint = await bridgeEndpoint({ upgradeAfter: Number.POSITIVE_INFINITY });
    const clock = new TestClock(CLOCK_ORIGIN);
    const transport = new WebSocketApiTransport(endpoint.origin, clock);
    transport.open();
    const waiting = transport.waitForBridge(new AbortController().signal);
    void waiting.catch(() => undefined);
    const bridgeSettled = async (): Promise<"pending" | "settled"> =>
        await Promise.race([
            waiting.then(
                () => "settled" as const,
                () => "settled" as const,
            ),
            Promise.resolve("pending" as const),
        ]);
    transport.disconnect();

    for (const [index, delay] of RECONNECT_DELAYS_MILLISECONDS.entries()) {
        clock.advanceBy(delay);
        await waitForArmedTimer(clock);
        expect(clock.pendingSleeps()).toBeGreaterThan(0);
        clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
        if (index < RECONNECT_DELAYS_MILLISECONDS.length - 1) {
            // The budget is still open, so waiting callers are not told yet.
            await waitForArmedTimer(clock);
            expect(await bridgeSettled()).toBe("pending");
        }
    }

    await expect(waiting).rejects.toMatchObject({ code: "bridge_unavailable" });
    await expect(transport.waitForBridge(new AbortController().signal)).rejects.toMatchObject({
        code: "bridge_unavailable",
    });

    // An explicit user retry after exhaustion dials again instead of being
    // refused forever; this attempt also stalls, so it fails in bounded time.
    const retrying = transport.fetch(new Request(`${endpoint.origin}/morty/api/chat/projects/p/bots/b/workspace`));
    void retrying.catch(() => undefined);
    await waitForArmedTimer(clock);
    clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
    await expect(retrying).rejects.toBeInstanceOf(ChatBridgeError);
    transport.dispose();
});
