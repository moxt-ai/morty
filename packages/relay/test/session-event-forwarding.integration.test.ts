import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerComputerFixture } from "./registered-computer.ts";

// Time stands still from the real present, so connection checks the Relay schedules stay in the future.
let start = 0;
beforeEach(() => {
    start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

/** Messages a socket received, in order. Waiting fails once the Relay closes the socket. */
class Inbox {
    readonly #pending: PromiseWithResolvers<Record<string, unknown>>[] = [];
    readonly #queued: Record<string, unknown>[] = [];
    #closed: Error | undefined;

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", (event) => {
            this.#closed = new Error(`The Relay closed the connection: ${event.code} ${event.reason}`);
            for (const pending of this.#pending.splice(0)) {
                pending.reject(this.#closed);
            }
        });
    }

    readonly next = (): Promise<Record<string, unknown>> => {
        const message = this.#queued.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        if (this.#closed !== undefined) {
            return Promise.reject(this.#closed);
        }
        const pending = Promise.withResolvers<Record<string, unknown>>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

interface ComputerConnection {
    readonly inbox: Inbox;
    readonly socket: WebSocket;
}

async function withComputerRelay(scenario: (connect: (path: string) => Promise<ComputerConnection>) => Promise<void>) {
    const computerId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerComputerFixture(computerId);
    const relay = env.COMPUTER_RELAY.getByName(computerId);
    const sockets: WebSocket[] = [];
    const connect = async (path: string): Promise<ComputerConnection> => {
        // This is the verified, Worker-to-Durable-Object HTTP boundary, not a public unauthenticated route.
        const response = await relay.fetch(`https://computer-relay.internal/computers/${computerId}/${path}`, {
            headers: {
                Upgrade: "websocket",
            },
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected an upgraded Computer connection");
        }
        const inbox = new Inbox(socket);
        sockets.push(socket);
        socket.accept();
        if (path === "daemon") {
            // The Relay attaches every daemon connection with liveness and announces when it is ready.
            expect(await inbox.next()).toEqual({ kind: "computer.liveness.ready" });
        }
        return { inbox, socket };
    };
    try {
        await scenario(connect);
    } finally {
        for (const socket of sockets) {
            socket.close(1000, "Test complete");
        }
    }
}

it("Given extensible native-pair daemon content, When a mixed-session batch is relayed, Then each browser receives every field only for its subscribed sessions and the daemon stays connected", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const all = await connect("host");
        const selected = await connect("host?harness=claude&sessionId=session-1");
        expect(await all.inbox.next()).toMatchObject({ kind: "computer.status", online: true });
        expect(await selected.inbox.next()).toMatchObject({ kind: "computer.status", online: true });
        const events = ["session-2", "session-1"].map((sessionId) => ({
            eventId: `event-${sessionId}`,
            position: "1",
            recordedAt: "2026-10-27T00:00:00.000Z",
            sessionGenerationId: "generation-1",
            target: { harness: "claude", sessionId: sessionId },
            type: "acp",
            futureEventField: { retained: true },
            payload: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
                status: "future_tool_status",
                futurePayloadField: { retained: true },
            },
        }));
        const envelope = { kind: "session.event.v2", events };
        daemon.socket.send(JSON.stringify(envelope));
        expect(await all.inbox.next()).toEqual(envelope);
        expect(await selected.inbox.next()).toEqual({
            ...envelope,
            events: events.filter((event) => event.target.sessionId === "session-1"),
        });
    });
});

it("Given future unroutable daemon variants, When the Relay receives them, Then it skips them and keeps forwarding known messages", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        expect(await host.inbox.next()).toMatchObject({ kind: "computer.status", online: true });

        for (const message of [
            { version: 3, message: { kind: "future" } },
            { kind: "future.computer.event", value: true },
            {
                kind: "session.status.changed",
                target: { harness: "claude", sessionId: "" },
                status: { kind: "future-status" },
            },
            {
                kind: "native.session.result",
                action: "future-action",
                requestId: "native-1",
            },
        ]) {
            daemon.socket.send(JSON.stringify(message));
        }
        daemon.socket.send(new Uint8Array([255, 0, 3]));

        const status = {
            kind: "session.status.changed",
            target: { harness: "claude", sessionId: "session-1" },
            status: { kind: "idle" },
        };
        daemon.socket.send(JSON.stringify(status));
        expect(await host.inbox.next()).toEqual(status);
        vi.setSystemTime(start + 60_000);
        daemon.socket.send(JSON.stringify({ version: 4 }));
        daemon.socket.send(JSON.stringify(status));
        expect(await host.inbox.next()).toEqual(status);
    });
});

it("Given future fields and routable events, When peers use the Relay, Then their payloads survive and session filters remain enforced", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        const selected = await connect("host?harness=claude&sessionId=session-1");
        const sender = await connect("live-history");
        await sender.inbox.next();
        await host.inbox.next();
        await selected.inbox.next();
        const command = { kind: "computer.ping", requestId: "ping-1", futureOptions: { format: 3 } };
        sender.socket.send(JSON.stringify(command));
        expect(await daemon.inbox.next()).toEqual(command);
        const reply = { kind: "computer.pong", requestId: "ping-1", futureResult: { retained: true } };
        daemon.socket.send(JSON.stringify(reply));
        // Hosts also receive the control command broadcast before its reply.
        expect(await host.inbox.next()).toEqual(command);
        expect(await host.inbox.next()).toEqual(reply);
        const future = {
            kind: "session.future.changed",
            target: { harness: "claude", sessionId: "session-1" },
            payload: { newFormat: [1, 2, 3] },
        };
        const otherSession = { ...future, target: { harness: "claude", sessionId: "session-2" } };
        daemon.socket.send(JSON.stringify(otherSession));
        expect(await host.inbox.next()).toEqual(otherSession);
        daemon.socket.send(JSON.stringify(future));
        expect(await host.inbox.next()).toEqual(future);
        // Drain the computer-wide control traffic for this subscriber.
        await selected.inbox.next();
        await selected.inbox.next();
        expect(await selected.inbox.next()).toEqual(future);
    });
});

it("Given a Session message with unknown variants and fields, When the Relay forwards it, Then the host receives the message unchanged", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        expect(await host.inbox.next()).toMatchObject({ kind: "computer.status", online: true });

        const message = {
            kind: "session.event.v2",
            futureEnvelopeField: { nested: [1, "two", null] },
            events: [
                {
                    eventId: "future-event-type",
                    position: "3",
                    recordedAt: "2026-10-27T00:00:00.000Z",
                    sessionGenerationId: "generation-1",
                    target: { harness: "claude", sessionId: "session-1" },
                    type: "future-event",
                    futureEventField: { retained: true },
                    payload: {
                        futurePayloadField: { retained: true },
                        value: [false, 42, "opaque"],
                    },
                },
                {
                    eventId: "future-session-update",
                    position: "4",
                    recordedAt: "2026-10-27T00:00:00.000Z",
                    sessionGenerationId: "generation-1",
                    target: { harness: "claude", sessionId: "session-1" },
                    type: "acp",
                    futureEventField: "retained",
                    payload: {
                        sessionUpdate: "future-session-update",
                        futurePayloadField: { retained: true },
                    },
                },
            ],
        };

        daemon.socket.send(JSON.stringify(message));
        expect(await host.inbox.next()).toEqual(message);
    });
});
