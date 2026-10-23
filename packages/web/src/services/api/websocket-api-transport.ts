import * as v from "valibot";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { type Clock, systemClock } from "../time/clock.ts";
import type { ApiResponseSnapshot } from "./api-transport.ts";

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
    watchReadyFrame,
    notificationFrame,
    eventFrame,
    subscriptionEndFrame,
]);
const permittedHeaders = new Set(["authorization", "content-type"]);
const KEEPALIVE_MILLISECONDS = 25_000;
/** Delays between automatic reconnects; the last entry repeats until the bridge returns. */
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Background attempts before Chat waits for a user action to dial again. */
const MAX_RECONNECT_ATTEMPTS = 10;
/**
 * How long one WebSocket upgrade may stay pending. A network that accepts the
 * TCP connection but never completes the handshake must not leave the bridge
 * connecting forever, so the attempt is abandoned and the retry budget continues.
 */
export const CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS = 10_000;

/**
 * A bridge failure that crosses the transport boundary. Requests and watches
 * receive it at their call site so product workflows handle it like any other
 * failed API call; subscriptions recover without surfacing it.
 */
export class ChatBridgeError extends Error {
    /** One stable code: every bridge failure means the same unavailable transport. */
    readonly code = "bridge_unavailable";
    constructor(message: string) {
        super(message);
        this.name = "ChatBridgeError";
    }
}

export function isChatBridgeError(cause: unknown): cause is ChatBridgeError {
    return cause instanceof ChatBridgeError;
}

const bridgeClosed = (): ChatBridgeError => new ChatBridgeError("The WebSocket to Morty is closed.");
const bridgeUnavailable = (): ChatBridgeError => new ChatBridgeError("The WebSocket to Morty could not connect.");

type BridgeState =
    | { readonly kind: "closed" }
    | { readonly kind: "disconnected" }
    | { readonly kind: "connecting"; readonly attempt: DialAttempt }
    | { readonly kind: "connected"; readonly socket: WebSocket };

/** One WebSocket upgrade, including its handshake deadline. */
interface DialAttempt {
    readonly connection: Promise<WebSocket>;
    readonly socket: WebSocket;
    /** Ends an unfinished handshake: closes the socket and settles the attempt. */
    readonly abandon: (cause: ChatBridgeError) => void;
}

interface PendingRequest {
    readonly workspaceKey: string | null;
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

interface PendingBridgeWaiter {
    readonly reject: (cause: unknown) => void;
    readonly resolve: () => void;
}

interface PendingEventStream extends PendingWatch {
    /** The subscription frame replayed after the bridge reconnects. */
    readonly frame: string;
    readonly receive: (data: string) => void;
}

export class WebSocketApiTransport {
    // A watch starts from what this authenticated client actually received,
    // including when registration or a reconnect happens after a change.
    readonly #workspaceBaselines = new Map<string, string>();
    readonly #clock: Clock;
    readonly #origin: string;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #eventStreams = new Map<string, PendingEventStream>();
    readonly #diagnostics = new Map<string, PendingDiagnostic>();
    readonly #watches = new Map<string, PendingWatch>();
    readonly #bridgeWaiters = new Set<PendingBridgeWaiter>();
    readonly #lifetime = new AbortController();
    #state: BridgeState = { kind: "disconnected" };
    #desired = false;
    #disposed = false;
    #reconnectAttempt = 0;
    #reconnectTimer: { readonly cancel: () => void } | null = null;

    constructor(origin: string, clock: Clock = systemClock) {
        this.#origin = new URL(origin).origin;
        this.#clock = clock;
    }

    readonly open = (): void => {
        if (this.#disposed) {
            return;
        }
        this.#desired = true;
        if (this.#state.kind === "closed") {
            this.#state = { kind: "disconnected" };
        }
        // An explicit open cancels the scheduled retry so the next call dials
        // immediately instead of failing fast while a timer is pending.
        this.#cancelReconnect();
        this.#reconnectAttempt = 0;
    };

    /**
     * Resolves once the bridge is connected, so a workflow whose background
     * watch was dropped with the socket can re-arm it. It never re-issues the
     * caller's request: the caller decides what is safe to repeat.
     */
    readonly waitForBridge = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.#disposed) {
            throw bridgeClosed();
        }
        if (this.#state.kind === "connected" && this.#state.socket.readyState === WebSocket.OPEN) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: PendingBridgeWaiter = {
                resolve: () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
                reject: (cause) => {
                    signal.removeEventListener("abort", abort);
                    reject(cause);
                },
            };
            const abort = () => {
                this.#bridgeWaiters.delete(waiter);
                waiter.reject(signal.reason);
            };
            this.#bridgeWaiters.add(waiter);
            signal.addEventListener("abort", abort, { once: true });
        });
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
        const socket = await this.#connectForCall(request.signal);
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
                workspaceKey:
                    request.method === "POST" && url.pathname.endsWith("/workspace") ? this.#watchKey(request) : null,
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
        const socket = await this.#connectForCall(parent);
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

    readonly #watchKey = (request: Request): string =>
        JSON.stringify([request.url, request.headers.get("authorization")]);

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
        const socket = await this.#connectForCall(request.signal);
        request.signal.throwIfAborted();
        const subscriptionId = crypto.randomUUID();
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                this.#sendIfConnected(JSON.stringify({ kind: "unwatch", subscriptionId }));
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
                        // Snapshot consumers adopt this watch's baseline. Notification-only
                        // consumers retain the preceding read as their comparison point.
                        baseline:
                            onReady === undefined ? this.#workspaceBaselines.get(this.#watchKey(request)) : undefined,
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
        const socket = await this.#connectForCall(request.signal);
        const subscriptionId = crypto.randomUUID();
        const frame = JSON.stringify({
            kind: "subscribe",
            subscriptionId,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
            body: null,
        });
        return await new Promise<void>((resolve, reject) => {
            const abort = () => {
                this.#sendIfConnected(JSON.stringify({ kind: "unwatch", subscriptionId }));
                this.#settleEventStream(subscriptionId)?.reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#eventStreams.set(subscriptionId, {
                frame,
                receive,
                reject,
                resolve,
                release: () => request.signal.removeEventListener("abort", abort),
            });
            try {
                socket.send(frame);
            } catch (cause) {
                this.#settleEventStream(subscriptionId)?.reject(cause);
            }
        });
    };

    /**
     * Drops the current bridge connection. Requests and watches in flight fail
     * at their call site; subscriptions stay registered and resume after the
     * transport reconnects on its own.
     */
    readonly disconnect = (): void => {
        if (this.#disposed) {
            return;
        }
        this.#desired = true;
        this.#dropConnection(bridgeClosed());
    };

    /** Releases the bridge for good and stops reconnecting. */
    readonly dispose = (): void => {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#workspaceBaselines.clear();
        this.#desired = false;
        this.#cancelReconnect();
        this.#lifetime.abort(bridgeClosed());
        this.#closeSocket("Chat API transport disposed");
        this.#state = { kind: "closed" };
        const cause = bridgeClosed();
        this.#rejectRequests(cause);
        for (const subscriptionId of [...this.#eventStreams.keys()]) {
            this.#settleEventStream(subscriptionId)?.reject(cause);
        }
        for (const waiter of [...this.#bridgeWaiters]) {
            this.#bridgeWaiters.delete(waiter);
            waiter.reject(cause);
        }
    };

    readonly #closeSocket = (reason: string): void => {
        const state = this.#state;
        if (state.kind === "connected") {
            state.socket.close(1000, reason);
        } else if (state.kind === "connecting") {
            // Closing during the handshake settles the attempt without waiting
            // for a close event the browser may never deliver.
            state.attempt.abandon(bridgeClosed());
        }
    };

    readonly #dropConnection = (cause: ChatBridgeError): void => {
        const state = this.#state;
        this.#state = { kind: "disconnected" };
        if (state.kind === "connected") {
            state.socket.close(1000, "Chat API transport disconnected");
        } else if (state.kind === "connecting") {
            state.attempt.abandon(cause);
        }
        this.#rejectRequests(cause);
        this.#scheduleReconnect();
    };

    readonly #rejectRequests = (cause: unknown): void => {
        for (const requestId of [...this.#pending.keys()]) {
            this.#settle(requestId)?.reject(cause);
        }
        for (const subscriptionId of [...this.#watches.keys()]) {
            this.#settleWatch(subscriptionId)?.reject(cause);
        }
        for (const requestId of [...this.#diagnostics.keys()]) {
            this.#settleDiagnostic(requestId)?.reject(cause);
        }
    };

    readonly #dial = async (): Promise<void> => {
        if (!this.#desired || this.#disposed) {
            return;
        }
        if (this.#state.kind === "connected" || this.#state.kind === "connecting") {
            return;
        }
        try {
            await this.#connect(this.#lifetime.signal);
        } catch {
            // The attempt already scheduled the next backoff or exhausted the
            // budget from its own failure path.
        }
    };

    readonly #scheduleReconnect = (): void => {
        if (!this.#desired || this.#disposed || this.#reconnectTimer !== null) {
            return;
        }
        // One attempt at a time: the in-flight attempt schedules the next
        // backoff when its handshake settles or its deadline expires.
        if (this.#state.kind === "connected" || this.#state.kind === "connecting") {
            return;
        }
        if (this.#reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            return;
        }
        const delay =
            RECONNECT_DELAYS_MILLISECONDS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MILLISECONDS.length - 1)] ??
            15_000;
        this.#reconnectAttempt += 1;
        const controller = new AbortController();
        const timer = {
            cancel: () => controller.abort(new Error("The Chat transport stopped reconnecting.")),
        };
        this.#reconnectTimer = timer;
        void this.#clock.sleep(delay, AbortSignal.any([this.#lifetime.signal, controller.signal])).then(
            () => {
                if (this.#reconnectTimer !== timer) {
                    return;
                }
                this.#reconnectTimer = null;
                if (this.#state.kind === "connected") {
                    this.#reconnectAttempt = 0;
                    return;
                }
                void this.#dial();
            },
            () => {
                if (this.#reconnectTimer === timer) {
                    this.#reconnectTimer = null;
                }
            },
        );
    };

    /**
     * A failed handshake continues the bounded budget: arm the next backoff, or
     * stop and tell waiting callers once the budget is spent.
     */
    readonly #attemptFailed = (): void => {
        if (!this.#desired || this.#disposed) {
            return;
        }
        // The budget is spent: stop background retries. The next user action
        // dials again through the normal call path.
        if (this.#reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            return;
        }
        this.#scheduleReconnect();
    };

    readonly #cancelReconnect = (): void => {
        const timer = this.#reconnectTimer;
        this.#reconnectTimer = null;
        timer?.cancel();
    };

    readonly #notifyConnected = (): void => {
        for (const waiter of [...this.#bridgeWaiters]) {
            this.#bridgeWaiters.delete(waiter);
            waiter.resolve();
        }
    };

    /** Re-registers live subscriptions so a reconnect never surfaces to subscribers. */
    readonly #replaySubscriptions = (socket: WebSocket): void => {
        for (const [subscriptionId, stream] of this.#eventStreams) {
            try {
                socket.send(stream.frame);
            } catch (cause) {
                this.#settleEventStream(subscriptionId)?.reject(cause);
            }
        }
    };

    readonly #sendIfConnected = (frame: string): void => {
        const state = this.#state;
        if (state.kind !== "connected" || state.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            state.socket.send(frame);
        } catch {
            // The connection closed first; the bridge already dropped the request.
            return;
        }
    };

    /**
     * API calls fail fast while a backoff attempt is pending, like a refused
     * HTTP connection, instead of racing another socket. Once the budget is
     * spent a call dials again, so an explicit user retry can recover.
     */
    readonly #connectForCall = async (signal: AbortSignal): Promise<WebSocket> => {
        if (this.#reconnectTimer !== null) {
            throw bridgeClosed();
        }
        return await this.#connect(signal);
    };

    readonly #connect = async (signal: AbortSignal): Promise<WebSocket> => {
        if (this.#disposed || this.#state.kind === "closed") {
            throw bridgeClosed();
        }
        if (this.#state.kind === "connected" && this.#state.socket.readyState === WebSocket.OPEN) {
            return this.#state.socket;
        }
        if (this.#state.kind === "connected") {
            this.#dropConnection(bridgeClosed());
        }
        if (this.#state.kind === "connecting") {
            return await this.#waitForConnection(this.#state.attempt.connection, signal);
        }
        const endpoint = new URL("/morty/ws", this.#origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const startedAt = performance.now();
        const socket = new WebSocket(endpoint);
        const deadline = new AbortController();
        let abandoned: (cause: ChatBridgeError) => void = () => undefined;
        const connection = new Promise<WebSocket>((resolve, reject) => {
            let settled = false;
            /** Ends the handshake exactly once: listeners and deadline go away. */
            const settle = (): boolean => {
                if (settled) {
                    return false;
                }
                settled = true;
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", closedWhileConnecting);
                deadline.abort(new Error("The Chat WebSocket handshake finished."));
                return true;
            };
            const releaseState = (): void => {
                if (this.#state.kind === "connecting" && this.#state.attempt.socket === socket && !this.#disposed) {
                    this.#state = { kind: "disconnected" };
                }
            };
            abandoned = (cause: ChatBridgeError): void => {
                if (!settle()) {
                    return;
                }
                try {
                    socket.close(1000, "Chat API transport stopped waiting for the handshake");
                } catch {
                    // The browser already discarded the socket.
                }
                releaseState();
                reject(cause);
                this.#attemptFailed();
            };
            const closedWhileConnecting = () => {
                if (!settle()) {
                    return;
                }
                releaseState();
                reject(bridgeClosed());
                this.#attemptFailed();
            };
            const opened = () => {
                if (!settle()) {
                    return;
                }
                if (this.#disposed || this.#state.kind !== "connecting" || this.#state.attempt.socket !== socket) {
                    socket.close(1000, "Chat API transport disposed");
                    reject(bridgeClosed());
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
                // A successful connection retires any backoff that was armed
                // while the attempt was in flight.
                this.#cancelReconnect();
                this.#reconnectAttempt = 0;
                this.#notifyConnected();
                this.#replaySubscriptions(socket);
                resolve(socket);
            };
            const failed = () => {
                if (!settle()) {
                    return;
                }
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "worker",
                    operation: "connection",
                    outcome: "connection_error",
                    requestId: "",
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
                releaseState();
                reject(bridgeUnavailable());
                this.#attemptFailed();
            };
            socket.addEventListener("open", opened, { once: true });
            socket.addEventListener("error", failed, { once: true });
            socket.addEventListener("close", closedWhileConnecting, { once: true });
            socket.addEventListener("message", (event) => {
                if (this.#state.kind === "connected" && this.#state.socket === socket) {
                    this.#receive(event);
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
                    if (this.#disposed) {
                        return;
                    }
                    const current =
                        this.#state.kind === "connected"
                            ? this.#state.socket === socket
                            : this.#state.kind === "connecting" && this.#state.attempt.socket === socket;
                    if (!current) {
                        // A socket from a finished attempt closing late must not
                        // touch the bridge that replaced it.
                        return;
                    }
                    if (this.#state.kind === "connected") {
                        this.#state = { kind: "disconnected" };
                    }
                    this.#rejectRequests(bridgeClosed());
                    this.#scheduleReconnect();
                },
                { once: true },
            );
            // A handshake the network never finishes must not pin the bridge in
            // "connecting": give up, release the state, and let the retry budget
            // continue from a clean slate.
            void this.#clock
                .sleep(
                    CHAT_BRIDGE_HANDSHAKE_TIMEOUT_MILLISECONDS,
                    AbortSignal.any([this.#lifetime.signal, deadline.signal]),
                )
                .then(
                    () => abandoned(bridgeUnavailable()),
                    () => undefined,
                );
        });
        this.#state = {
            kind: "connecting",
            attempt: { connection, socket, abandon: (cause) => abandoned(cause) },
        };
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
        if (frame.kind === "notification") {
            this.#settleWatch(frame.subscriptionId)?.resolve();
            return;
        }
        if (frame.kind === "watch.ready") {
            const pending = this.#watches.get(frame.subscriptionId);
            if (pending?.ready !== undefined) {
                try {
                    pending.ready({ status: frame.status, headers: new Headers(frame.headers), body: frame.body });
                } catch (cause) {
                    if (this.#settleWatch(frame.subscriptionId) !== undefined) {
                        this.#sendIfConnected(
                            JSON.stringify({ kind: "unwatch", subscriptionId: frame.subscriptionId }),
                        );
                        pending.reject(cause);
                    }
                }
            }
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
        if (pending.workspaceKey !== null && frame.status >= 200 && frame.status < 300) {
            this.#workspaceBaselines.set(pending.workspaceKey, `${frame.status}\u0000${frame.body ?? ""}`);
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
