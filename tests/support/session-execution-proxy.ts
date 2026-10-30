import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** Forwards real traffic unchanged, with controllable ordering at the Platform transport boundary. */
export async function createSessionExecutionProxy(upstream: string) {
    let hold: ((release: () => void) => void) | null = null;
    let holdSteer: ((release: () => Promise<unknown>) => void) | null = null;
    let holdSubmission: ((release: () => void) => void) | null = null;
    let heldEvents: (() => void)[] | null = null;
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
    const connections = new WebSocketServer({ server });
    connections.on("connection", (client, incoming) => {
        const target = new URL(incoming.url ?? "/", upstream);
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
        });
        sockets.add(client);
        sockets.add(remote);
        const pending: (() => void)[] = [];
        const responses = new Map<string, (frame: unknown) => void>();
        client.on("message", (data, binary) => {
            const send = () => {
                if (remote.readyState === WebSocket.OPEN) {
                    remote.send(data, { binary });
                } else {
                    pending.push(() => remote.send(data, { binary }));
                }
            };
            const frame: unknown = binary ? null : JSON.parse(data.toString());
            if (
                holdSteer !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                "requestId" in frame &&
                typeof frame.requestId === "string" &&
                new URL(frame.path, upstream).pathname.endsWith("/disposition")
            ) {
                const held = holdSteer;
                holdSteer = null;
                const requestId = frame.requestId;
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
            const send = () => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data, { binary });
                }
            };
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
        holdNextExecution: () =>
            new Promise<() => void>((resolve) => {
                hold = resolve;
            }),
        /** Holds the next turn submission before the Runtime receives it, until the returned release. */
        holdNextSubmission: () =>
            new Promise<() => void>((resolve) => {
                holdSubmission = resolve;
            }),
        holdNextSteer: () =>
            new Promise<() => Promise<unknown>>((resolve) => {
                holdSteer = resolve;
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
        close: async () => {
            for (const socket of sockets) {
                socket.terminate();
            }
            connections.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
