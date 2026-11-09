import { createServer, request } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { listen, port } from "./websocket.ts";

/** The text of a response body as the service encoded it on the wire. */
function decoded(encoding: string | undefined, chunks: readonly Buffer[]): string {
    const body = Buffer.concat(chunks);
    switch (encoding) {
        case "gzip":
            return gunzipSync(body).toString("utf8");
        case "br":
            return brotliDecompressSync(body).toString("utf8");
        case "deflate":
            return inflateSync(body).toString("utf8");
        default:
            return body.toString("utf8");
    }
}

/**
 * A real network proxy: forwards requests unchanged, then loses one request before it reaches the service, one request's
 * response, one turn admission response, or delays one request.
 */
export async function createResponseLossProxy(upstream: string) {
    // The next response to lose: the service handles the request, but the caller never receives its answer.
    let lostResponse: {
        readonly path: RegExp;
        readonly lost: (response: { readonly status: number; readonly body: string }) => void;
    } | null = null;
    const loseNextResponseWithBody = (path: RegExp) =>
        new Promise<{ readonly status: number; readonly body: string }>((resolve) => {
            lostResponse = { path, lost: resolve };
        });
    const loseNextResponse = async (path: RegExp) => (await loseNextResponseWithBody(path)).status;
    // The next request to lose on its way: the service never receives it.
    let droppedRequest: RegExp | null = null;
    const server = createServer((incoming, outgoing) => {
        if (droppedRequest !== null && incoming.method === "POST" && droppedRequest.test(incoming.url ?? "")) {
            droppedRequest = null;
            incoming.resume();
            outgoing.destroy();
            return;
        }
        const forwarded = request(
            new URL(incoming.url ?? "/", upstream),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                if (lostResponse !== null && incoming.method === "POST" && lostResponse.path.test(incoming.url ?? "")) {
                    const { lost } = lostResponse;
                    lostResponse = null;
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () => {
                        lost({
                            status: response.statusCode ?? 502,
                            body: decoded(response.headers["content-encoding"], chunks),
                        });
                        outgoing.destroy();
                    });
                    return;
                }
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.on("aborted", () => forwarded.destroy());
        incoming.pipe(forwarded);
    });
    let heldConfiguration: { readonly client: WebSocket; readonly data: Buffer; readonly binary: boolean } | null =
        null;
    let holdConfiguration: { readonly resolve: () => void } | null = null;
    const sockets = new Set<WebSocket>();
    const webSockets = new WebSocketServer({ server });
    let armed: "before-acceptance" | "after-acceptance" | "held" | null = null;
    // A held submission reaches the service only when the scenario releases it, as a slow network would deliver it.
    const held: { readonly remote: WebSocket; readonly data: Buffer; readonly binary: boolean }[] = [];
    let reconnectsBlocked = false;
    const submissions: string[] = [];
    webSockets.on("connection", (client, incoming) => {
        if (reconnectsBlocked) {
            client.terminate();
            return;
        }
        sockets.add(client);
        const target = new URL(incoming.url ?? "/", upstream);
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
            ...(incoming.headers.authorization === undefined
                ? {}
                : { headers: { authorization: incoming.headers.authorization } }),
        });
        sockets.add(remote);
        let configurationResponse: { readonly requestId: string; readonly ready: () => void } | null = null;
        let lostRequestId: string | null = null;
        const pending: { readonly data: Buffer; readonly binary: boolean }[] = [];
        client.on("message", (data, binary) => {
            const bytes = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(new Uint8Array(data));
            if (!binary) {
                const frame: unknown = JSON.parse(bytes.toString());
                if (
                    holdConfiguration !== null &&
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    frame.path.endsWith("/configuration") &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string"
                ) {
                    configurationResponse = { requestId: frame.requestId, ready: holdConfiguration.resolve };
                    holdConfiguration = null;
                }

                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    frame.path.endsWith("/turns") &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string" &&
                    "body" in frame &&
                    typeof frame.body === "string"
                ) {
                    submissions.push(frame.body);
                    if (armed === "held") {
                        armed = null;
                        held.push({ remote, data: bytes, binary });
                        return;
                    }
                    if (armed !== null) {
                        const delivery = armed;
                        armed = null;
                        if (delivery === "before-acceptance") {
                            reconnectsBlocked = true;
                            client.terminate();
                            remote.terminate();
                            return;
                        }
                        lostRequestId = frame.requestId;
                    }
                }
            }
            if (remote.readyState === WebSocket.OPEN) {
                remote.send(bytes, { binary });
            } else {
                pending.push({ data: bytes, binary });
            }
        });
        remote.on("open", () => {
            for (const frame of pending.splice(0)) {
                remote.send(frame.data, { binary: frame.binary });
            }
        });
        remote.on("message", (data, binary) => {
            if (configurationResponse !== null && !binary) {
                const frame: unknown = JSON.parse(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    frame.requestId === configurationResponse.requestId
                ) {
                    heldConfiguration = { client, data: Buffer.from(data.toString()), binary };
                    configurationResponse.ready();
                    configurationResponse = null;
                    return;
                }
            }

            if (lostRequestId !== null) {
                const frame: unknown = binary ? null : JSON.parse(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    frame.requestId === lostRequestId
                ) {
                    // The service accepted the request. Lose its response and any confirming live events.
                    reconnectsBlocked = true;
                    client.terminate();
                    remote.terminate();
                }
                return;
            }
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary });
            }
        });
        client.on("error", () => remote.terminate());
        remote.on("error", () => client.terminate());
        client.on("close", () => {
            sockets.delete(client);
            remote.terminate();
        });
        remote.on("close", () => {
            sockets.delete(remote);
            client.terminate();
        });
    });
    await listen(server);
    return {
        origin: `http://127.0.0.1:${port(server)}`,
        submissions,
        /** Holds one real settings edit response, letting later notifications and reads pass unchanged. */
        holdNextConfigurationResponse: () =>
            new Promise<void>((resolve) => {
                holdConfiguration = { resolve };
            }),
        releaseConfigurationResponse: () => {
            if (heldConfiguration !== null) {
                heldConfiguration.client.send(heldConfiguration.data, { binary: heldConfiguration.binary });
                heldConfiguration = null;
            }
        },
        /** Loses a pairing response after the real service commits it. */
        interruptNextRuntimePairing: () => loseNextResponseWithBody(/\/management\/pairings(?:\?|$)/u),
        interruptNextFork: () => loseNextResponse(/\/native-session-forks\//u),
        /** Loses the next Session creation before it reaches the service, which therefore creates nothing. */
        dropNextSessionCreation: () => {
            droppedRequest = /\/runtimes\/[^/]+\/sessions(?:\?|$)/u;
        },
        /** Loses the answer to the next Session creation; resolves with the status the service returned. */
        interruptNextSessionCreation: () => loseNextResponse(/\/runtimes\/[^/]+\/sessions(?:\?|$)/u),
        interruptNextTurn: (delivery: "before-acceptance" | "after-acceptance") => {
            armed = delivery;
        },
        /** Delays the next turn submission on the network until released; the browser cannot tell it was sent. */
        holdNextTurn: () => {
            armed = "held";
        },
        releaseHeldTurn: () => {
            for (const request of held.splice(0)) {
                request.remote.send(request.data, { binary: request.binary });
            }
        },
        reconnect: () => {
            reconnectsBlocked = false;
        },
        close: async () => {
            for (const socket of sockets) {
                socket.terminate();
            }
            webSockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
