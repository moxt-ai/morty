import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** Forwards real traffic unchanged, with a controllable delay before one execution read reaches the Platform. */
export async function createSessionExecutionProxy(upstream: string) {
    let hold: ((release: () => void) => void) | null = null;
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
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary });
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
