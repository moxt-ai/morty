import { createServer, type IncomingMessage, request } from "node:http";
import type { Duplex } from "node:stream";
import { decodeNativeSessionResult } from "@morty-build/client/protocol";
import { WebSocket, WebSocketServer } from "ws";

/** Forwards real traffic unchanged, with controllable ordering at the Platform transport boundary. */
export async function createSessionExecutionProxy(upstream: string) {
    let hold: ((release: () => void) => void) | null = null;
    // Requests held by the end of their path until released, each release returning the Runtime's response.
    const heldReplies = new Map<string, (release: () => Promise<unknown>) => void>();
    let holdCloseNotice: ((release: () => void) => void) | null = null;
    let holdSubmission: ((release: () => void) => void) | null = null;
    let heldEvents: (() => void)[] | null = null;
    let heldTerminalEvents: Map<WebSocket, (() => void)[]> | null = null;
    let terminalObserved: (() => void) | null = null;
    const executionReads: {
        readonly turn: string | null;
        readonly lastTurn: string | null;
        readonly lastTurnState: string | null;
        readonly interactionPosition: string | null;
    }[] = [];
    let heldRuntimeHosts: (() => void)[] | null = null;
    let openRuntimeHosts = 0;
    const runtimeHostWaiters: (() => void)[] = [];
    const heldUpgrades = new Set<Duplex>();
    const server = createServer((incoming, outgoing) => {
        const forwarded = request(
            new URL(incoming.url ?? "/", upstream),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.on("aborted", () => forwarded.destroy());
        incoming.pipe(forwarded);
    });
    const sockets = new Set<WebSocket>();
    const connections = new WebSocketServer({ noServer: true });
    const isRuntimeHost = (url: string | undefined): boolean =>
        new URL(url ?? "/", upstream).pathname.endsWith("/host");
    server.on("upgrade", (incoming, socket, head) => {
        const accept = () => {
            if (!socket.destroyed) {
                connections.handleUpgrade(incoming, socket, head, (client) =>
                    connections.emit("connection", client, incoming),
                );
            }
        };
        if (heldRuntimeHosts !== null && isRuntimeHost(incoming.url)) {
            heldUpgrades.add(socket);
            heldRuntimeHosts.push(() => {
                heldUpgrades.delete(socket);
                accept();
            });
            return;
        }
        accept();
    });
    connections.on("connection", (client: WebSocket, incoming: IncomingMessage) => {
        const target = new URL(incoming.url ?? "/", upstream);
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
            ...(incoming.headers.authorization === undefined
                ? {}
                : { headers: { authorization: incoming.headers.authorization } }),
        });
        sockets.add(client);
        sockets.add(remote);
        if (isRuntimeHost(incoming.url)) {
            remote.on("open", () => {
                openRuntimeHosts += 1;
                for (const opened of runtimeHostWaiters.splice(0)) {
                    opened();
                }
                remote.on("close", () => {
                    openRuntimeHosts -= 1;
                });
            });
        }
        const pending: (() => void)[] = [];
        let delayedCloseTraffic: (() => void)[] | null = null;
        const responses = new Map<string, (frame: unknown) => void>();
        const executionRequests = new Set<string>();
        client.on("message", (data, binary) => {
            const send = () => {
                if (remote.readyState === WebSocket.OPEN) {
                    remote.send(data, { binary });
                } else {
                    pending.push(() => remote.send(data, { binary }));
                }
            };
            const frame: unknown = binary ? null : JSON.parse(data.toString());
            const heldReply =
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                "requestId" in frame &&
                typeof frame.requestId === "string"
                    ? { path: new URL(frame.path, upstream).pathname, requestId: frame.requestId }
                    : null;
            if (heldReply?.path.endsWith("/active-turn")) {
                executionRequests.add(heldReply.requestId);
            }
            const heldSuffix =
                heldReply === null ? undefined : [...heldReplies.keys()].find((end) => heldReply.path.endsWith(end));
            const held = heldSuffix === undefined ? undefined : heldReplies.get(heldSuffix);
            if (heldReply !== null && heldSuffix !== undefined && held !== undefined) {
                heldReplies.delete(heldSuffix);
                const requestId = heldReply.requestId;
                const response = new Promise<unknown>((resolve) => responses.set(requestId, resolve));
                held(async () => {
                    send();
                    return await response;
                });
                return;
            }
            if (
                holdSubmission !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "method" in frame &&
                frame.method === "POST" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                new URL(frame.path, upstream).pathname.endsWith("/turns")
            ) {
                const held = holdSubmission;
                holdSubmission = null;
                held(send);
                return;
            }
            if (
                hold !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                new URL(frame.path, upstream).pathname.endsWith("/active-turn")
            ) {
                const held = hold;
                hold = null;
                held(send);
                return;
            }
            send();
        });
        remote.on("open", () => {
            for (const send of pending.splice(0)) {
                send();
            }
        });
        remote.on("message", (data, binary) => {
            const frame: unknown = binary ? null : JSON.parse(data.toString());
            if (
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.response" &&
                "requestId" in frame &&
                typeof frame.requestId === "string" &&
                executionRequests.delete(frame.requestId) &&
                "status" in frame &&
                frame.status === 200 &&
                "body" in frame &&
                typeof frame.body === "string"
            ) {
                const snapshot = decodeNativeSessionResult(frame.body);
                if (snapshot.action === "active-turn") {
                    executionReads.push({
                        turn: snapshot.turn?.commandId ?? null,
                        lastTurn: snapshot.lastTurn?.commandId ?? null,
                        lastTurnState: snapshot.lastTurn?.state ?? null,
                        interactionPosition: snapshot.interactionState?.throughPosition ?? null,
                    });
                }
            }
            const send = () => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data, { binary });
                }
            };
            if (delayedCloseTraffic !== null) {
                delayedCloseTraffic.push(send);
                return;
            }
            if (
                holdCloseNotice !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "session.close.notice"
            ) {
                const held = holdCloseNotice;
                holdCloseNotice = null;
                const pending = [send];
                delayedCloseTraffic = pending;
                held(() => {
                    delayedCloseTraffic = null;
                    for (const forward of pending.splice(0)) {
                        forward();
                    }
                });
                return;
            }
            if (
                heldTerminalEvents !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "session.events.event" &&
                "data" in frame &&
                typeof frame.data === "string"
            ) {
                const batch: unknown = JSON.parse(frame.data);
                const terminal =
                    Array.isArray(batch) &&
                    batch.some(
                        (event: unknown) =>
                            typeof event === "object" &&
                            event !== null &&
                            "type" in event &&
                            event.type === "lifecycle-metadata" &&
                            "payload" in event &&
                            typeof event.payload === "object" &&
                            event.payload !== null &&
                            "kind" in event.payload &&
                            (event.payload.kind === "prompt.completed" || event.payload.kind === "prompt.failed"),
                    );
                const pending = heldTerminalEvents.get(client);
                if (pending !== undefined || terminal) {
                    const queue = pending ?? [];
                    queue.push(send);
                    heldTerminalEvents.set(client, queue);
                    if (terminal) {
                        terminalObserved?.();
                    }
                    return;
                }
            }
            if (
                heldEvents !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "session.events.event"
            ) {
                heldEvents.push(send);
                return;
            }
            send();
            if (
                typeof frame === "object" &&
                frame !== null &&
                "requestId" in frame &&
                typeof frame.requestId === "string"
            ) {
                responses.get(frame.requestId)?.(frame);
                responses.delete(frame.requestId);
            }
        });
        for (const [socket, peer] of [
            [client, remote],
            [remote, client],
        ] as const) {
            socket.on("error", () => peer.terminate());
            socket.on("close", () => {
                sockets.delete(socket);
                peer.terminate();
            });
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a listening proxy");
    }
    return {
        origin: `http://127.0.0.1:${address.port}`,
        observedExecutionReads: () => [...executionReads],
        /** Delays real terminal events and every later event on the same connection without reordering them. */
        holdTerminalSessionEvents: () => {
            const pending = new Map<WebSocket, (() => void)[]>();
            const observed = Promise.withResolvers<void>();
            heldTerminalEvents = pending;
            terminalObserved = observed.resolve;
            return {
                observed: observed.promise,
                release: () => {
                    heldTerminalEvents = null;
                    terminalObserved = null;
                    for (const queue of pending.values()) {
                        for (const send of queue) {
                            send();
                        }
                    }
                    pending.clear();
                },
            };
        },
        /** Delays the close notice and later traffic on its connection, leaving the Session event stream independent. */
        holdNextCloseNotice: () =>
            new Promise<() => void>((resolve) => {
                holdCloseNotice = resolve;
            }),
        holdNextExecution: () =>
            new Promise<() => void>((resolve) => {
                hold = resolve;
            }),
        /** Holds the next turn submission before the Runtime receives it, until the returned release. */
        holdNextSubmission: () =>
            new Promise<() => void>((resolve) => {
                holdSubmission = resolve;
            }),
        /** Holds the next steer before the Runtime receives it; the release forwards it and returns the response. */
        holdNextSteer: () =>
            new Promise<() => Promise<unknown>>((resolve) => {
                heldReplies.set("/disposition", resolve);
            }),
        /** Holds the next withdrawal of a queued message; the release forwards it and returns the response. */
        holdNextQueuedCancellation: () =>
            new Promise<() => Promise<unknown>>((resolve) => {
                heldReplies.set("/cancel-before-start", resolve);
            }),
        holdSessionEvents: () => {
            const pending: (() => void)[] = [];
            heldEvents = pending;
            return () => {
                heldEvents = null;
                for (const send of pending.splice(0)) {
                    send();
                }
            };
        },
        /**
         * Waits until a Runtime host connection is open, then keeps every later one from connecting until the
         * returned release, as when the Runtime cannot be reached for a new connection.
         */
        holdLaterRuntimeHosts: async (): Promise<() => void> => {
            if (openRuntimeHosts === 0) {
                await new Promise<void>((resolve) => runtimeHostWaiters.push(resolve));
            }
            const held: (() => void)[] = [];
            heldRuntimeHosts = held;
            return () => {
                if (heldRuntimeHosts === held) {
                    heldRuntimeHosts = null;
                }
                for (const accept of held.splice(0)) {
                    accept();
                }
            };
        },
        close: async () => {
            for (const socket of sockets) {
                socket.terminate();
            }
            for (const socket of heldUpgrades) {
                socket.destroy();
            }
            connections.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
