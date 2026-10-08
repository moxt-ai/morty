import * as v from "valibot";

const responseBeginFrame = v.strictObject({
    kind: v.literal("response.begin"),
    requestId: v.string(),
    status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
    headers: v.array(v.tuple([v.string(), v.string()])),
});
const responseEndFrame = v.strictObject({ kind: v.literal("response.end"), requestId: v.string() });
const errorFrame = v.strictObject({
    kind: v.literal("error"),
    requestId: v.nullable(v.string()),
    code: v.string(),
    message: v.string(),
});
const pongFrame = v.strictObject({ kind: v.literal("pong") });
const notificationFrame = v.strictObject({ kind: v.literal("notification"), subscriptionId: v.string() });
const eventFrame = v.strictObject({ kind: v.literal("event"), subscriptionId: v.string(), data: v.string() });
const subscriptionEndFrame = v.strictObject({ kind: v.literal("subscription.end"), subscriptionId: v.string() });
const serverFrame = v.variant("kind", [
    responseBeginFrame,
    responseEndFrame,
    errorFrame,
    pongFrame,
    notificationFrame,
    eventFrame,
    subscriptionEndFrame,
]);
const permittedHeaders = new Set(["authorization", "content-type"]);
const KEEPALIVE_MILLISECONDS = 25_000;

type BridgeState =
    | { readonly kind: "closed" }
    | { readonly kind: "disconnected" }
    | { readonly kind: "connecting"; readonly connection: Promise<WebSocket> }
    | { readonly kind: "connected"; readonly socket: WebSocket };

interface PendingRequest {
    readonly reject: (cause: unknown) => void;
    readonly resolve: (response: Response) => void;
    readonly release: () => void;
    response: { readonly chunks: Uint8Array[]; readonly headers: [string, string][]; readonly status: number } | null;
}

interface PendingWatch {
    readonly reject: (cause: unknown) => void;
    readonly resolve: () => void;
    readonly release: () => void;
}

interface PendingEventStream extends PendingWatch {
    readonly receive: (data: string) => void;
}

function decodeResponseChunk(value: unknown): { readonly requestId: string; readonly bytes: Uint8Array } | null {
    let bytes: Uint8Array;
    if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
        return null;
    }
    const requestIdLength = bytes[0] ?? 0;
    if (requestIdLength === 0 || requestIdLength > 128 || bytes.byteLength < 1 + requestIdLength) {
        return null;
    }
    return {
        requestId: new TextDecoder().decode(bytes.subarray(1, 1 + requestIdLength)),
        bytes: bytes.slice(1 + requestIdLength),
    };
}

export class WebSocketApiTransport {
    readonly #origin: string;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #eventStreams = new Map<string, PendingEventStream>();
    readonly #watches = new Map<string, PendingWatch>();
    #state: BridgeState = { kind: "disconnected" };

    constructor(origin: string) {
        this.#origin = new URL(origin).origin;
    }

    readonly open = (): void => {
        if (this.#state.kind === "closed") {
            this.#state = { kind: "disconnected" };
        }
    };

    readonly fetch = async (request: Request): Promise<Response> => {
        request.signal.throwIfAborted();
        const url = new URL(request.url);
        if (url.origin !== this.#origin || !url.pathname.startsWith("/morty/api/")) {
            throw new Error("The API request cannot use the Chat WebSocket bridge.");
        }
        const headers: [string, string][] = [];
        for (const [name, value] of request.headers) {
            if (!permittedHeaders.has(name.toLowerCase())) {
                continue;
            }
            headers.push([name, value]);
        }
        const body = request.body === null ? null : await request.text();
        request.signal.throwIfAborted();
        const socket = await this.#connect(request.signal);
        request.signal.throwIfAborted();
        const requestId = crypto.randomUUID();
        return await new Promise<Response>((resolve, reject) => {
            const abort = () => {
                socket.send(JSON.stringify({ kind: "cancel", requestId }));
                this.#settle(requestId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#pending.set(requestId, {
                reject,
                resolve,
                release: () => request.signal.removeEventListener("abort", abort),
                response: null,
            });
            try {
                socket.send(
                    JSON.stringify({
                        kind: "request",
                        requestId,
                        method: request.method,
                        path: `${url.pathname}${url.search}`,
                        headers,
                        body,
                    }),
                );
            } catch (cause) {
                this.#settle(requestId)?.reject(cause);
            }
        });
    };

    readonly waitForChange = async (request: Request): Promise<void> => {
        request.signal.throwIfAborted();
        const url = new URL(request.url);
        if (
            url.origin !== this.#origin ||
            (!url.pathname.endsWith("/workspace") && !url.pathname.endsWith("/setup/runtimes")) ||
            request.method !== "POST"
        ) {
            throw new Error("The API request cannot be watched through the Chat WebSocket bridge.");
        }
        const headers: [string, string][] = [];
        for (const [name, value] of request.headers) {
            if (permittedHeaders.has(name.toLowerCase())) {
                headers.push([name, value]);
            }
        }
        const requestBody = await request.text();
        const body = requestBody === "" ? null : requestBody;
        request.signal.throwIfAborted();
        const socket = await this.#connect(request.signal);
        const subscriptionId = crypto.randomUUID();
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                socket.send(JSON.stringify({ kind: "unwatch", subscriptionId }));
                this.#settleWatch(subscriptionId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#watches.set(subscriptionId, {
                reject,
                resolve,
                release: () => request.signal.removeEventListener("abort", abort),
            });
            try {
                socket.send(
                    JSON.stringify({
                        kind: "watch",
                        subscriptionId,
                        method: request.method,
                        path: `${url.pathname}${url.search}`,
                        headers,
                        body,
                    }),
                );
            } catch (cause) {
                this.#settleWatch(subscriptionId)?.reject(cause);
            }
        });
    };

    readonly subscribe = async (request: Request, receive: (data: string) => void): Promise<void> => {
        request.signal.throwIfAborted();
        const url = new URL(request.url);
        if (
            url.origin !== this.#origin ||
            !url.pathname.endsWith("/managed-session/status-events") ||
            request.method !== "POST"
        ) {
            throw new Error("The API request cannot subscribe through the Chat WebSocket bridge.");
        }
        const headers: [string, string][] = [];
        for (const [name, value] of request.headers) {
            if (permittedHeaders.has(name.toLowerCase())) {
                headers.push([name, value]);
            }
        }
        const socket = await this.#connect(request.signal);
        const subscriptionId = crypto.randomUUID();
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                socket.send(JSON.stringify({ kind: "unwatch", subscriptionId }));
                this.#settleEventStream(subscriptionId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#eventStreams.set(subscriptionId, {
                receive,
                reject,
                resolve,
                release: () => request.signal.removeEventListener("abort", abort),
            });
            try {
                socket.send(
                    JSON.stringify({
                        kind: "subscribe",
                        subscriptionId,
                        method: request.method,
                        path: `${url.pathname}${url.search}`,
                        headers,
                        body: null,
                    }),
                );
            } catch (cause) {
                this.#settleEventStream(subscriptionId)?.reject(cause);
            }
        });
    };

    readonly close = (): void => {
        const state = this.#state;
        this.#state = { kind: "closed" };
        if (state.kind === "connected") {
            state.socket.close(1000, "Chat API transport closed");
        } else if (state.kind === "connecting") {
            void state.connection.then(
                (socket) => socket.close(1000, "Chat API transport closed"),
                () => undefined,
            );
        }
        for (const requestId of [...this.#pending.keys()]) {
            this.#settle(requestId)?.reject(new Error("The Chat API transport closed."));
        }
        for (const subscriptionId of [...this.#watches.keys()]) {
            this.#settleWatch(subscriptionId)?.reject(new Error("The Chat API transport closed."));
        }
        for (const subscriptionId of [...this.#eventStreams.keys()]) {
            this.#settleEventStream(subscriptionId)?.reject(new Error("The Chat API transport closed."));
        }
    };

    readonly #connect = async (signal: AbortSignal): Promise<WebSocket> => {
        if (this.#state.kind === "closed") {
            throw new Error("The Chat API transport is closed.");
        }
        if (this.#state.kind === "connected" && this.#state.socket.readyState === WebSocket.OPEN) {
            return this.#state.socket;
        }
        if (this.#state.kind === "connecting") {
            return await this.#waitForConnection(this.#state.connection, signal);
        }
        const endpoint = new URL("/morty/ws", this.#origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(endpoint);
        socket.binaryType = "arraybuffer";
        const connection = new Promise<WebSocket>((resolve, reject) => {
            const closedWhileConnecting = () => {
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                if (this.#state.kind !== "closed") {
                    this.#state = { kind: "disconnected" };
                }
                reject(new Error("The Chat WebSocket bridge closed while connecting."));
            };
            const opened = () => {
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", closedWhileConnecting);
                if (this.#state.kind === "closed") {
                    socket.close(1000, "Chat API transport closed");
                    reject(new Error("The Chat API transport is closed."));
                    return;
                }
                this.#state = { kind: "connected", socket };
                const keepalive = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ kind: "ping" }));
                    }
                }, KEEPALIVE_MILLISECONDS);
                socket.addEventListener("close", () => clearInterval(keepalive), { once: true });
                resolve(socket);
            };
            const failed = () => {
                socket.removeEventListener("open", opened);
                socket.removeEventListener("close", closedWhileConnecting);
                if (this.#state.kind !== "closed") {
                    this.#state = { kind: "disconnected" };
                }
                reject(new Error("The Chat WebSocket bridge could not connect."));
            };
            socket.addEventListener("open", opened, { once: true });
            socket.addEventListener("error", failed, { once: true });
            socket.addEventListener("close", closedWhileConnecting, { once: true });
            socket.addEventListener("message", this.#receive);
            socket.addEventListener(
                "close",
                () => {
                    if (this.#state.kind === "connected" && this.#state.socket === socket) {
                        this.#state = { kind: "disconnected" };
                    }
                    for (const requestId of [...this.#pending.keys()]) {
                        this.#settle(requestId)?.reject(new Error("The Chat WebSocket bridge disconnected."));
                    }
                    for (const subscriptionId of [...this.#watches.keys()]) {
                        this.#settleWatch(subscriptionId)?.reject(new Error("The Chat WebSocket bridge disconnected."));
                    }
                    for (const subscriptionId of [...this.#eventStreams.keys()]) {
                        this.#settleEventStream(subscriptionId)?.reject(
                            new Error("The Chat WebSocket bridge disconnected."),
                        );
                    }
                },
                { once: true },
            );
        });
        this.#state = { kind: "connecting", connection };
        return await this.#waitForConnection(connection, signal);
    };

    readonly #waitForConnection = async (connection: Promise<WebSocket>, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        return await new Promise<WebSocket>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            void connection.then(
                (socket) => {
                    signal.removeEventListener("abort", abort);
                    signal.aborted ? reject(signal.reason) : resolve(socket);
                },
                (cause: unknown) => {
                    signal.removeEventListener("abort", abort);
                    reject(signal.aborted ? signal.reason : cause);
                },
            );
        });
    };

    readonly #receive = (event: MessageEvent): void => {
        if (typeof event.data !== "string") {
            const chunk = decodeResponseChunk(event.data);
            if (chunk === null) {
                return;
            }
            const pending = this.#pending.get(chunk.requestId);
            if (pending?.response !== null && pending?.response !== undefined) {
                pending.response.chunks.push(chunk.bytes);
            }
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(event.data);
        } catch {
            return;
        }
        const parsed = v.safeParse(serverFrame, value);
        if (!parsed.success || parsed.output.kind === "pong") {
            return;
        }
        const frame = parsed.output;
        if (frame.kind === "notification") {
            this.#settleWatch(frame.subscriptionId)?.resolve();
            return;
        }
        if (frame.kind === "event") {
            const subscription = this.#eventStreams.get(frame.subscriptionId);
            if (subscription !== undefined) {
                try {
                    subscription.receive(frame.data);
                } catch (cause) {
                    this.#settleEventStream(frame.subscriptionId)?.reject(cause);
                }
            }
            return;
        }
        if (frame.kind === "subscription.end") {
            this.#settleEventStream(frame.subscriptionId)?.resolve();
            return;
        }
        if (frame.requestId === null) {
            return;
        }
        const pending = this.#pending.get(frame.requestId);
        if (pending === undefined) {
            if (frame.kind === "error") {
                this.#settleEventStream(frame.requestId)?.reject(new Error(`${frame.code}: ${frame.message}`));
            }
            return;
        }
        if (frame.kind === "error") {
            this.#settle(frame.requestId)?.reject(new Error(`${frame.code}: ${frame.message}`));
            return;
        }
        if (frame.kind === "response.begin") {
            if (pending.response !== null) {
                this.#settle(frame.requestId)?.reject(new Error("The Chat API response started more than once."));
                return;
            }
            pending.response = { chunks: [], headers: frame.headers, status: frame.status };
            return;
        }
        const response = pending.response;
        if (response === null) {
            this.#settle(frame.requestId)?.reject(new Error("The Chat API response ended before it started."));
            return;
        }
        const length = response.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of response.chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this.#settle(frame.requestId)?.resolve(
            new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
                status: response.status,
                headers: response.headers,
            }),
        );
    };

    readonly #settle = (requestId: string): PendingRequest | undefined => {
        const pending = this.#pending.get(requestId);
        if (pending !== undefined) {
            this.#pending.delete(requestId);
            pending.release();
        }
        return pending;
    };

    readonly #settleWatch = (subscriptionId: string): PendingWatch | undefined => {
        const pending = this.#watches.get(subscriptionId);
        if (pending !== undefined) {
            this.#watches.delete(subscriptionId);
            pending.release();
        }
        return pending;
    };

    readonly #settleEventStream = (subscriptionId: string): PendingEventStream | undefined => {
        const pending = this.#eventStreams.get(subscriptionId);
        if (pending === undefined) {
            return undefined;
        }
        this.#eventStreams.delete(subscriptionId);
        pending.release();
        return pending;
    };
}
