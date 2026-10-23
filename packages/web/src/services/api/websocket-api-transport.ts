import * as v from "valibot";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import type { ApiResponseSnapshot } from "./api-transport.ts";
import { ChatConnectionError } from "./chat-connection-error.ts";

const responseFrame = v.strictObject({
    kind: v.literal("response"),
    requestId: v.string(),
    status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
    headers: v.array(v.tuple([v.string(), v.string()])),
    body: v.nullable(v.string()),
});
const errorFrame = v.strictObject({
    kind: v.literal("error"),
    requestId: v.nullable(v.string()),
    code: v.string(),
    message: v.string(),
});
const pongFrame = v.strictObject({ kind: v.literal("pong") });
const diagnosticPongFrame = v.strictObject({ kind: v.literal("diagnostic.pong"), requestId: v.string() });
const watchReadyFrame = v.strictObject({
    kind: v.literal("watch.ready"),
    subscriptionId: v.string(),
    status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
    headers: v.array(v.tuple([v.string(), v.string()])),
    body: v.string(),
});
const notificationFrame = v.strictObject({ kind: v.literal("notification"), subscriptionId: v.string() });
const eventFrame = v.strictObject({ kind: v.literal("event"), subscriptionId: v.string(), data: v.string() });
const subscriptionEndFrame = v.strictObject({ kind: v.literal("subscription.end"), subscriptionId: v.string() });
const mobiusHealthSchema = v.strictObject({ service: v.literal("mobius-relay-platform"), status: v.literal("ok") });
const serverFrame = v.variant("kind", [
    responseFrame,
    errorFrame,
    pongFrame,
    diagnosticPongFrame,
    notificationFrame,
    watchReadyFrame,
    eventFrame,
    subscriptionEndFrame,
]);
const permittedHeaders = new Set(["authorization", "content-type"]);
const KEEPALIVE_MILLISECONDS = 25_000;

type BridgeState =
    | { readonly kind: "closed" }
    | { readonly kind: "disconnected" }
    | { readonly kind: "connecting"; readonly connection: Promise<WebSocket>; readonly socket: WebSocket }
    | { readonly kind: "connected"; readonly socket: WebSocket };

interface PendingRequest {
    readonly reject: (cause: unknown) => void;
    readonly resolve: (response: Response) => void;
    readonly release: () => void;
}

interface PendingWatch {
    readonly ready?: (snapshot: ApiResponseSnapshot) => void;
    readonly reject: (cause: unknown) => void;
    readonly resolve: () => void;
    readonly release: () => void;
}

interface PendingDiagnostic {
    readonly reject: (cause: unknown) => void;
    readonly release: () => void;
    readonly resolve: (latencyMs: number) => void;
    readonly startedAt: number;
}

interface PendingEventStream extends PendingWatch {
    readonly receive: (data: string) => void;
}

export class WebSocketApiTransport {
    readonly #origin: string;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #eventStreams = new Map<string, PendingEventStream>();
    readonly #diagnostics = new Map<string, PendingDiagnostic>();
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
        const requestId = crypto.randomUUID();
        const started = performance.now();
        const operation = new URL(request.url).pathname.split("/").slice(-1)[0] ?? "request";
        try {
            const response = await this.#fetch(request, requestId);
            response.headers.set("x-morty-request-id", requestId);
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "worker",
                operation,
                requestId,
                elapsedMs: Math.round(performance.now() - started),
                outcome: String(response.status),
            });
            return response;
        } catch (cause) {
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "worker",
                operation,
                requestId,
                elapsedMs: Math.round(performance.now() - started),
                outcome: request.signal.aborted ? "cancelled" : "error",
            });
            throw cause;
        }
    };
    readonly #fetch = async (request: Request, requestId: string): Promise<Response> => {
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
        return await new Promise<Response>((resolve, reject) => {
            const abort = () => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ kind: "cancel", requestId }));
                }
                this.#settle(requestId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#pending.set(requestId, {
                reject,
                resolve,
                release: () => request.signal.removeEventListener("abort", abort),
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

    readonly measureMortyLatency = async (parent: AbortSignal): Promise<number> => {
        parent.throwIfAborted();
        const socket = await this.#connect(parent);
        parent.throwIfAborted();
        const requestId = crypto.randomUUID();
        const timeout = AbortSignal.timeout(10_000);
        const signal = AbortSignal.any([parent, timeout]);
        return await new Promise<number>((resolve, reject) => {
            const abort = () => this.#settleDiagnostic(requestId)?.reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            this.#diagnostics.set(requestId, {
                reject,
                release: () => signal.removeEventListener("abort", abort),
                resolve,
                startedAt: performance.now(),
            });
            try {
                socket.send(JSON.stringify({ kind: "diagnostic.ping", requestId }));
            } catch (cause) {
                this.#settleDiagnostic(requestId)?.reject(cause);
            }
        });
    };

    readonly measureMobiusLatency = async (origin: string, parent: AbortSignal): Promise<number> => {
        parent.throwIfAborted();
        const endpoint = new URL(origin);
        if (
            endpoint.origin !== origin ||
            (endpoint.protocol !== "https:" &&
                !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) ||
            endpoint.username !== "" ||
            endpoint.password !== "" ||
            endpoint.pathname !== "/" ||
            endpoint.search !== "" ||
            endpoint.hash !== ""
        ) {
            throw new Error("The Mobius diagnostic endpoint is invalid.");
        }
        endpoint.pathname = "/mobius/api/dashboard/health";
        endpoint.searchParams.set("diagnostic", crypto.randomUUID());
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
        const startedAt = performance.now();
        const response = await fetch(endpoint, { cache: "no-store", signal });
        signal.throwIfAborted();
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Mobius did not respond to the network diagnostic.");
        }
        v.parse(mobiusHealthSchema, await response.json());
        return Math.max(0, Math.round(performance.now() - startedAt));
    };

    readonly waitForChange = async (
        request: Request,
        onReady?: (snapshot: ApiResponseSnapshot) => void,
    ): Promise<void> => {
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
        request.signal.throwIfAborted();
        const subscriptionId = crypto.randomUUID();
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ kind: "unwatch", subscriptionId }));
                }
                this.#settleWatch(subscriptionId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#watches.set(subscriptionId, {
                ...(onReady === undefined ? {} : { ready: onReady }),
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
        request.signal.throwIfAborted();
        const subscriptionId = crypto.randomUUID();
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ kind: "unwatch", subscriptionId }));
                }
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
        if (state.kind === "connected" || state.kind === "connecting") {
            state.socket.close(1000, "Chat API transport closed");
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
        for (const requestId of [...this.#diagnostics.keys()]) {
            this.#settleDiagnostic(requestId)?.reject(new Error("The Chat API transport closed."));
        }
    };

    readonly #connect = async (signal: AbortSignal): Promise<WebSocket> => {
        if (this.#state.kind === "closed") {
            throw new Error("The Chat API transport is closed.");
        }
        if (this.#state.kind === "connected") {
            if (this.#state.socket.readyState === WebSocket.OPEN) {
                return this.#state.socket;
            }
            this.#disconnected(this.#state.socket);
        }
        if (this.#state.kind === "connecting") {
            return await this.#waitForConnection(this.#state.connection, signal);
        }
        const endpoint = new URL("/morty/ws", this.#origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const startedAt = performance.now();
        const socket = new WebSocket(endpoint);
        const connection = new Promise<WebSocket>((resolve, reject) => {
            const deadline = setTimeout(
                () => rejectConnection(new ChatConnectionError("CHAT_CONNECTION_TIMEOUT")),
                10_000,
            );
            const closedWhileConnecting = () => {
                clearTimeout(deadline);
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                if (this.#state.kind === "connecting" && this.#state.socket === socket) {
                    this.#state = { kind: "disconnected" };
                }
                reject(new ChatConnectionError());
            };
            const opened = () => {
                clearTimeout(deadline);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", closedWhileConnecting);
                if (this.#state.kind !== "connecting" || this.#state.socket !== socket) {
                    socket.close(1000, "Chat API transport closed");
                    reject(new Error("The Chat API connection is no longer active."));
                    return;
                }
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "worker",
                    operation: "connection",
                    outcome: "connected",
                    requestId: "",
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
                this.#state = { kind: "connected", socket };
                const keepalive = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ kind: "ping" }));
                    }
                }, KEEPALIVE_MILLISECONDS);
                socket.addEventListener("close", () => clearInterval(keepalive), { once: true });
                resolve(socket);
            };
            const failed = () => rejectConnection(new ChatConnectionError());
            const rejectConnection = (cause: ChatConnectionError) => {
                clearTimeout(deadline);
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "worker",
                    operation: "connection",
                    outcome: "connection_error",
                    requestId: "",
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", closedWhileConnecting);
                if (this.#state.kind === "connecting" && this.#state.socket === socket) {
                    this.#state = { kind: "disconnected" };
                }
                socket.close();
                reject(cause);
            };
            socket.addEventListener("open", opened, { once: true });
            socket.addEventListener("error", failed, { once: true });
            socket.addEventListener("close", closedWhileConnecting, { once: true });
            socket.addEventListener("message", (event) => {
                if (this.#state.kind === "connected" && this.#state.socket === socket) {
                    this.#receive(event, socket);
                }
            });
            socket.addEventListener(
                "close",
                (event) => {
                    recordBrowserDiagnostic({
                        at: new Date().toISOString(),
                        component: "worker",
                        operation: "connection",
                        outcome: "disconnected",
                        closeCode: event.code,
                        requestId: "",
                        elapsedMs: 0,
                    });
                    this.#disconnected(socket);
                },
                { once: true },
            );
        });
        this.#state = { kind: "connecting", connection, socket };
        return await this.#waitForConnection(connection, signal);
    };

    readonly #disconnected = (socket: WebSocket): void => {
        if (this.#state.kind !== "connected" || this.#state.socket !== socket) {
            return;
        }
        this.#state = { kind: "disconnected" };
        for (const requestId of [...this.#pending.keys()]) {
            this.#settle(requestId)?.reject(new ChatConnectionError());
        }
        for (const subscriptionId of [...this.#watches.keys()]) {
            this.#settleWatch(subscriptionId)?.reject(new ChatConnectionError());
        }
        for (const subscriptionId of [...this.#eventStreams.keys()]) {
            this.#settleEventStream(subscriptionId)?.reject(new ChatConnectionError());
        }
        for (const requestId of [...this.#diagnostics.keys()]) {
            this.#settleDiagnostic(requestId)?.reject(new ChatConnectionError());
        }
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

    readonly #receive = (event: MessageEvent, socket: WebSocket): void => {
        if (typeof event.data !== "string") {
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
        if (frame.kind === "diagnostic.pong") {
            const pending = this.#settleDiagnostic(frame.requestId);
            if (pending !== undefined) {
                pending.resolve(Math.max(0, Math.round(performance.now() - pending.startedAt)));
            }
            return;
        }
        if (frame.kind === "watch.ready") {
            const pending = this.#watches.get(frame.subscriptionId);
            if (pending?.ready !== undefined) {
                try {
                    pending.ready({ status: frame.status, headers: new Headers(frame.headers), body: frame.body });
                } catch (cause) {
                    if (this.#settleWatch(frame.subscriptionId) !== undefined) {
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({ kind: "unwatch", subscriptionId: frame.subscriptionId }));
                        }
                        pending.reject(cause);
                    }
                }
            }
            return;
        }
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
            this.#settleWatch(frame.subscriptionId)?.reject(new ChatConnectionError());
            return;
        }
        if (frame.requestId === null) {
            return;
        }
        const pending = this.#pending.get(frame.requestId);
        if (pending === undefined) {
            if (frame.kind === "error") {
                const failure = new Error(`${frame.code}: ${frame.message}`);
                this.#settleEventStream(frame.requestId)?.reject(failure);
                this.#settleWatch(frame.requestId)?.reject(failure);
            }
            return;
        }
        if (frame.kind === "error") {
            this.#settle(frame.requestId)?.reject(new Error(`${frame.code}: ${frame.message}`));
            return;
        }
        this.#settle(frame.requestId)?.resolve(
            new Response(frame.status === 204 || frame.status === 205 || frame.status === 304 ? null : frame.body, {
                status: frame.status,
                headers: frame.headers,
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

    readonly #settleDiagnostic = (requestId: string): PendingDiagnostic | undefined => {
        const pending = this.#diagnostics.get(requestId);
        if (pending !== undefined) {
            this.#diagnostics.delete(requestId);
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
