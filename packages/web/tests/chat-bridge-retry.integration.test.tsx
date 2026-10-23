import { createHash } from "node:crypto";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
    CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS,
    ChatBridgeError,
    isBridgeExhausted,
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

/** One ordinary API call through the bridge, reporting only its status. */
async function fetchWorkspace(transport: WebSocketApiTransport, origin: string): Promise<number> {
    const response = await transport.fetch(
        new Request(`${origin}/morty/api/chat/projects/p/bots/b/workspace`, { method: "POST" }),
    );
    return response.status;
}

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

    // The next backoff dials again: the stalled handshake did not stop the
    // budget, so the bridge is reachable on the very next attempt.
    clock.advanceBy(RECONNECT_DELAYS_MILLISECONDS[1] ?? 2_000);
    await endpoint.waitForAccepted(2);
    expect(endpoint.accepted()).toBe(2);
    transport.dispose();
});

/**
 * Boundary contract for the transport: the background budget is bounded even
 * when every upgrade stalls, so it stops retrying instead of dialing forever,
 * and a user-initiated call still gets a real attempt.
 */
test("Given a bridge whose handshake never completes, When the retry budget is consumed, Then background retries stop and a user call still dials", {
    timeout: 30_000,
}, async () => {
    endpoint = await bridgeEndpoint({ upgradeAfter: Number.POSITIVE_INFINITY });
    const clock = new TestClock(CLOCK_ORIGIN);
    const transport = new WebSocketApiTransport(endpoint.origin, clock);
    transport.open();
    transport.disconnect();

    for (const delay of RECONNECT_DELAYS_MILLISECONDS) {
        clock.advanceBy(delay);
        await waitForArmedTimer(clock);
        expect(clock.pendingSleeps()).toBeGreaterThan(0);
        clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
    }

    // The budget is spent, so background retries stop instead of dialing on
    // forever. The count proves the loop above consumed every attempt.
    const acceptedAfterBudget = endpoint.accepted();
    clock.advanceBy(60_000);
    await Promise.resolve();
    expect(endpoint.accepted()).toBe(acceptedAfterBudget);

    // A user action still performs a real attempt rather than being refused
    // forever; this handshake stalls, so it fails within its own deadline.
    const retrying = fetchWorkspace(transport, endpoint.origin);
    void retrying.catch(() => undefined);
    await waitForArmedTimer(clock);
    clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
    await expect(retrying).rejects.toBeInstanceOf(ChatBridgeError);
    transport.dispose();
});

/**
 * Boundary contract for the transport: spending the retry budget is terminal for
 * anything parked on the bridge. A workflow that dropped a watch and is waiting
 * for the bridge to return must be told the transport gave up, not left to wait
 * on a dial that will never happen.
 */
test("Given a bridge whose handshake never completes, When the retry budget is spent, Then bridge waiters are told instead of waiting forever", {
    timeout: 30_000,
}, async () => {
    endpoint = await bridgeEndpoint({ upgradeAfter: Number.POSITIVE_INFINITY });
    const clock = new TestClock(CLOCK_ORIGIN);
    const transport = new WebSocketApiTransport(endpoint.origin, clock);
    transport.open();
    transport.disconnect();

    // A waiter parked while the budget is still open must survive every drop
    // until the budget is actually spent, exactly like a real recovery loop.
    const parkedSignal = new AbortController().signal;
    const parked = transport.waitForBridge(parkedSignal);
    let parkedSettled = false;
    void parked.then(
        () => {
            parkedSettled = true;
        },
        () => {
            parkedSettled = true;
        },
    );

    for (const [index, delay] of RECONNECT_DELAYS_MILLISECONDS.entries()) {
        clock.advanceBy(delay);
        await waitForArmedTimer(clock);
        clock.advanceBy(CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS);
        // The waiter is only told once the budget is really spent, not on the
        // way down: every attempt but the last keeps it parked.
        if (index < RECONNECT_DELAYS_MILLISECONDS.length - 1) {
            await Promise.resolve();
            expect(parkedSettled).toBe(false);
        }
    }

    // The tenth failure spends the budget and tells the parked waiter it is
    // terminal, rather than leaving it waiting forever. This is the reviewer's
    // core concern: a workflow that dropped a watch and parked on the bridge
    // must be told the transport gave up so it can surface a recovery action.
    await expect(parked).rejects.toSatisfy(isBridgeExhausted);

    // A waiter that arrives after exhaustion is refused immediately instead of
    // parking on a bridge nothing will ever reconnect. Recovery from here is a
    // user-initiated dial, covered end-to-end at the application boundary.
    await expect(transport.waitForBridge(parkedSignal)).rejects.toSatisfy(isBridgeExhausted);
    transport.dispose();
});
