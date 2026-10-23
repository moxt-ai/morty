import { connect, createServer, type Socket } from "node:net";

/** A real TCP link to Chat; faults drop connections without replacing any API responses. */
export async function createChatNetwork(origin: string) {
    const target = new URL(origin);
    const sockets = new Set<Socket>();
    let connected = true;
    const server = createServer((client) => {
        if (!connected) {
            client.destroy();
            return;
        }
        const upstream = connect(Number(target.port), target.hostname);
        sockets.add(client);
        sockets.add(upstream);
        const release = () => {
            sockets.delete(client);
            sockets.delete(upstream);
            client.destroy();
            upstream.destroy();
        };
        client.on("error", release);
        upstream.on("error", release);
        client.on("close", release);
        upstream.on("close", release);
        client.pipe(upstream);
        upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The Chat network link did not start");
    }
    const disconnect = (): void => {
        connected = false;
        for (const socket of sockets) {
            socket.destroy();
        }
    };
    return {
        origin: `http://127.0.0.1:${address.port}`,
        disconnect,
        reconnect: (): void => {
            connected = true;
        },
        close: async (): Promise<void> => {
            disconnect();
            await new Promise<void>((resolve, reject) =>
                server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
            );
        },
    };
}
