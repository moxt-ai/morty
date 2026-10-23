import { connect, createServer, type Server, type Socket } from "node:net";

export interface BridgeProxy {
    /** The stable origin clients dial; the Worker never sees this port directly. */
    readonly origin: string;
    /**
     * Takes the bridge down and back up without moving the origin. While down, a
     * dialing client's upgrade is accepted at the TCP layer but never answered,
     * so the transport abandons each attempt on its own clock-driven handshake
     * deadline and consumes its bounded reconnect budget deterministically; an
     * already-open bridge is severed at once. While up, every dial is piped to
     * the Worker and reconnects.
     */
    readonly drop: () => void;
    readonly restore: () => void;
    readonly close: () => Promise<void>;
}

/**
 * A TCP pass-through on a fixed loopback port in front of the real Chat Worker.
 *
 * The bridge endpoint cannot be moved without either freeing the Worker's port
 * (which races other suites for a just-released port) or rewriting the request
 * Origin (which the Worker's upgrade rejects). This proxy keeps one stable
 * origin for the whole scenario and only changes whether it forwards: `drop`
 * stalls every upgrade so the transport's handshake deadline drives each failed
 * attempt, and `restore` lets the next dial reach the Worker again. It pipes
 * bytes verbatim, so the Worker's Origin check sees the same host it would over
 * a direct connection.
 */
export async function createBridgeProxy(target: string): Promise<BridgeProxy> {
    const upstream = new URL(target);
    const upstreamPort = Number.parseInt(upstream.port, 10);
    const sockets = new Set<Socket>();
    let forwarding = true;
    const server: Server = createServer((client) => {
        sockets.add(client);
        const forget = () => sockets.delete(client);
        client.on("close", forget);
        client.on("error", forget);
        if (!forwarding) {
            // Hold the connection open without answering the upgrade. The
            // transport's handshake deadline then abandons the attempt on its
            // own clock, which is what makes exhaustion deterministic here
            // instead of dependent on real connection-refused I/O timing.
            return;
        }
        pipeUpstream(upstreamPort, client, forget);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a bridge proxy port");
    }
    const { port } = address;
    return {
        origin: `http://127.0.0.1:${port}`,
        drop: () => {
            forwarding = false;
            // Sever live sockets so an already-connected bridge drops at once,
            // the way a network cut does; later dials stall instead.
            for (const socket of [...sockets]) {
                socket.destroy();
            }
        },
        restore: () => {
            forwarding = true;
        },
        close: async () => {
            for (const socket of [...sockets]) {
                socket.destroy();
            }
            sockets.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/**
 * Connects one client socket to the Worker and pipes both directions verbatim.
 * Ownership is explicit: whichever side ends first destroys the other and the
 * caller forgets the client, so no socket outlives the scenario.
 */
function pipeUpstream(upstreamPort: number, client: Socket, forget: () => void): void {
    const worker = connect(upstreamPort, "127.0.0.1");
    const release = () => {
        worker.destroy();
        client.destroy();
        forget();
    };
    worker.on("error", release);
    client.on("close", release);
    worker.on("close", release);
    client.pipe(worker);
    worker.pipe(client);
}
