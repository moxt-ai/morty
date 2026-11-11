import { env } from "cloudflare:workers";
import { encodeSessionCloseNoticeEvent } from "@morty-build/client/protocol";
import { expect, it } from "vitest";
import { registerComputerFixture } from "./registered-computer.ts";

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

it("Given hosts watching every Session and a single Session, When the Computer reports a Session closed, Then the Relay delivers the notice to the hosts watching that Session", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const everySession = await connect("host");
        expect(await everySession.inbox.next()).toMatchObject({ kind: "computer.status", online: true });
        const sessionSeven = await connect("host?harness=claude&sessionId=session-7");
        expect(await sessionSeven.inbox.next()).toMatchObject({ kind: "computer.status", online: true });
        const sessionEight = await connect("host?harness=claude&sessionId=session-8");
        expect(await sessionEight.inbox.next()).toMatchObject({ kind: "computer.status", online: true });

        for (const sessionId of ["session-7", "session-8"]) {
            daemon.socket.send(
                encodeSessionCloseNoticeEvent({
                    kind: "session.close.notice",
                    reason: "This Session was closed on request.",
                    target: { harness: "claude", sessionId: sessionId },
                }),
            );
        }

        expect(await everySession.inbox.next()).toEqual({
            kind: "session.close.notice",
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-7" },
        });
        expect(await everySession.inbox.next()).toEqual({
            kind: "session.close.notice",
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-8" },
        });
        expect(await sessionSeven.inbox.next()).toEqual({
            kind: "session.close.notice",
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-7" },
        });
        // The first message this host receives is the second notice, so the first never reached it.
        expect(await sessionEight.inbox.next()).toEqual({
            kind: "session.close.notice",
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-8" },
        });
    });
});

it("Given a host filtered to a native pair, When the Computer disconnects, Then the host still learns that its Computer is offline", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host?harness=claude&sessionId=session-7");
        expect(await host.inbox.next()).toMatchObject({ kind: "computer.status", online: true });
        daemon.socket.close(1000, "Computer stopped");
        expect(await host.inbox.next()).toMatchObject({ kind: "computer.status", online: false });
    });
});

it("Given an unknown Computer notice with a Session route, When the Computer sends it, Then the Relay forwards it and keeps the connection open", async () => {
    await withComputerRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        expect(await host.inbox.next()).toMatchObject({ kind: "computer.status", online: true });

        daemon.socket.send(
            JSON.stringify({
                kind: "session.future.notice",
                target: { harness: "claude", sessionId: "session-7" },
            }),
        );
        expect(await host.inbox.next()).toEqual({
            kind: "session.future.notice",
            target: { harness: "claude", sessionId: "session-7" },
        });
        // The host receives the next notice only if the Relay kept the connection open after the unknown message.
        daemon.socket.send(
            encodeSessionCloseNoticeEvent({
                kind: "session.close.notice",
                reason: "This Session was closed on request.",
                target: { harness: "claude", sessionId: "session-7" },
            }),
        );

        expect(await host.inbox.next()).toEqual({
            kind: "session.close.notice",
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-7" },
        });
    });
});
