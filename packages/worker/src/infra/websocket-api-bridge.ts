import * as v from "valibot";
import { toHttpError } from "./http-error.ts";
import { RequestError } from "./request-error.ts";

const requestId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/u));
const requestFrame = v.strictObject({
    kind: v.literal("request"),
    requestId,
    method: v.picklist(["DELETE", "GET", "PATCH", "POST", "PUT"]),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    headers: v.pipe(v.array(v.tuple([v.string(), v.string()])), v.maxLength(16)),
    body: v.nullable(v.pipe(v.string(), v.maxLength(7_000_000))),
});
const watchFrame = v.strictObject({
    kind: v.literal("watch"),
    subscriptionId: requestId,
    method: v.picklist(["GET", "POST"]),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    headers: v.pipe(v.array(v.tuple([v.string(), v.string()])), v.maxLength(16)),
    body: v.nullable(v.pipe(v.string(), v.maxLength(7_000_000))),
});
const subscribeFrame = v.strictObject({
    kind: v.literal("subscribe"),
    subscriptionId: requestId,
    method: v.literal("POST"),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    headers: v.pipe(v.array(v.tuple([v.string(), v.string()])), v.maxLength(16)),
    body: v.null(),
});
const unwatchFrame = v.strictObject({ kind: v.literal("unwatch"), subscriptionId: requestId });
const cancelFrame = v.strictObject({ kind: v.literal("cancel"), requestId });
const pingFrame = v.strictObject({ kind: v.literal("ping") });
const diagnosticPingFrame = v.strictObject({ kind: v.literal("diagnostic.ping"), requestId });
const clientFrame = v.variant("kind", [
    requestFrame,
    watchFrame,
    subscribeFrame,
    unwatchFrame,
    cancelFrame,
    pingFrame,
    diagnosticPingFrame,
]);
const CONNECTION_IDLE_MILLISECONDS = 60_000;
const REQUEST_TIMEOUT_MILLISECONDS = 120_000;

interface BridgeSocket extends WebSocket {
    accept(): void;
}

interface BridgeLogger {
    readonly error: (value: unknown, message: string) => void;
}

export interface WebSocketBridgeRequest {
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly path: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string | null;
}

export interface WebSocketBridgeHandlers {
    readonly resolve: (
        request: WebSocketBridgeRequest,
        operation: "request" | "subscribe" | "watch",
        signal: AbortSignal,
    ) => Request;
    readonly dispatch: (request: Request) => Promise<Response>;
    readonly subscribe: (
        request: Request,
        observer: { readonly notify: () => void; readonly publish: (data: string) => void },
        signal: AbortSignal,
    ) => Promise<void>;
}

function send(socket: BridgeSocket, value: Readonly<Record<string, unknown>>): void {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
    }
}

function encodeResponseChunk(requestIdValue: string, chunk: Uint8Array): Uint8Array {
    const encodedRequestId = new TextEncoder().encode(requestIdValue);
    const frame = new Uint8Array(1 + encodedRequestId.byteLength + chunk.byteLength);
    frame[0] = encodedRequestId.byteLength;
    frame.set(encodedRequestId, 1);
    frame.set(chunk, 1 + encodedRequestId.byteLength);
    return frame;
}

async function sendResponse(
    socket: BridgeSocket,
    requestIdValue: string,
    response: Response,
    signal: AbortSignal,
): Promise<void> {
    send(socket, {
        kind: "response.begin",
        requestId: requestIdValue,
        status: response.status,
        headers: [...response.headers],
    });
    const reader = response.body?.getReader();
    if (reader !== undefined) {
        try {
            while (true) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }
                if (socket.readyState !== WebSocket.OPEN) {
                    throw new Error("The WebSocket bridge closed while sending a response.");
                }
                socket.send(encodeResponseChunk(requestIdValue, chunk.value));
            }
        } finally {
            reader.releaseLock();
        }
    }
    signal.throwIfAborted();
    send(socket, { kind: "response.end", requestId: requestIdValue });
}

function protocolError(socket: BridgeSocket, requestIdValue: string | null): void {
    send(socket, {
        kind: "error",
        requestId: requestIdValue,
        code: "INVALID_BRIDGE_REQUEST",
        message: "The bridged request is invalid.",
    });
}

export function createWebSocketApiBridge(
    request: Request,
    handlers: WebSocketBridgeHandlers,
    logger: BridgeLogger,
): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        throw new RequestError("WEBSOCKET_UPGRADE_REQUIRED", "A WebSocket upgrade is required.", 426);
    }
    if (request.headers.get("Origin") !== new URL(request.url).origin) {
        throw new RequestError("WEBSOCKET_ORIGIN_FORBIDDEN", "The WebSocket origin is not allowed.", 403);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as BridgeSocket;
    const pending = new Map<string, AbortController>();
    const watches = new Map<string, AbortController>();
    let idleTimer: ReturnType<typeof setTimeout>;
    const refreshIdleDeadline = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => server.close(1001, "Bridge idle timeout"), CONNECTION_IDLE_MILLISECONDS);
    };
    const release = () => {
        clearTimeout(idleTimer);
        for (const controller of pending.values()) {
            controller.abort(new Error("The WebSocket bridge closed."));
        }
        pending.clear();
        for (const controller of watches.values()) {
            controller.abort(new Error("The WebSocket bridge closed."));
        }
        watches.clear();
    };
    server.accept();
    refreshIdleDeadline();
    server.addEventListener("close", release, { once: true });
    server.addEventListener("error", release, { once: true });
    server.addEventListener("message", (event) => {
        refreshIdleDeadline();
        if (typeof event.data !== "string") {
            protocolError(server, null);
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(event.data);
        } catch {
            protocolError(server, null);
            return;
        }
        const parsed = v.safeParse(clientFrame, value);
        if (!parsed.success) {
            protocolError(server, null);
            return;
        }
        const frame = parsed.output;
        if (frame.kind === "ping") {
            send(server, { kind: "pong" });
            return;
        }
        if (frame.kind === "diagnostic.ping") {
            send(server, { kind: "diagnostic.pong", requestId: frame.requestId });
            return;
        }
        if (frame.kind === "cancel") {
            pending.get(frame.requestId)?.abort(new Error("The bridged request was cancelled."));
            return;
        }
        if (frame.kind === "unwatch") {
            watches.get(frame.subscriptionId)?.abort(new Error("The bridge watch stopped."));
            watches.delete(frame.subscriptionId);
            refreshIdleDeadline();
            return;
        }
        if (frame.kind === "watch" || frame.kind === "subscribe") {
            if (watches.has(frame.subscriptionId)) {
                protocolError(server, frame.subscriptionId);
                return;
            }
            const lifetime = new AbortController();
            let request: Request;
            try {
                request = handlers.resolve(frame, frame.kind, lifetime.signal);
            } catch {
                protocolError(server, frame.subscriptionId);
                return;
            }
            watches.set(frame.subscriptionId, lifetime);
            refreshIdleDeadline();
            void handlers
                .subscribe(
                    request,
                    {
                        notify: () => send(server, { kind: "notification", subscriptionId: frame.subscriptionId }),
                        publish: (data) => send(server, { data, kind: "event", subscriptionId: frame.subscriptionId }),
                    },
                    lifetime.signal,
                )
                .catch((cause: unknown) => {
                    if (!lifetime.signal.aborted) {
                        logger.error(
                            { err: cause, subscriptionId: frame.subscriptionId },
                            "WebSocket bridge subscription failed",
                        );
                    }
                })
                .finally(() => {
                    if (watches.get(frame.subscriptionId) === lifetime) {
                        watches.delete(frame.subscriptionId);
                        if (!lifetime.signal.aborted) {
                            send(server, { kind: "subscription.end", subscriptionId: frame.subscriptionId });
                        }
                        refreshIdleDeadline();
                    }
                });
            return;
        }
        if (pending.has(frame.requestId)) {
            protocolError(server, frame.requestId);
            return;
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
        let dispatchedRequest: Request;
        try {
            dispatchedRequest = handlers.resolve(frame, "request", signal);
        } catch {
            protocolError(server, frame.requestId);
            return;
        }
        pending.set(frame.requestId, controller);
        refreshIdleDeadline();
        void handlers
            .dispatch(dispatchedRequest)
            .then(async (response) => {
                await sendResponse(server, frame.requestId, response, signal);
            })
            .catch((cause: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                const httpError = toHttpError(
                    signal.aborted
                        ? new RequestError("BRIDGE_REQUEST_TIMEOUT", "The bridged request timed out.", 504, { cause })
                        : cause,
                );
                logger.error({ err: cause, requestId: frame.requestId }, "WebSocket bridge request failed");
                const reportedError =
                    httpError.status >= 500 && httpError.status < 600 ? toHttpError(undefined) : httpError;
                send(server, {
                    kind: "error",
                    requestId: frame.requestId,
                    code: reportedError.body.error.code,
                    message: reportedError.body.error.message,
                });
            })
            .finally(() => {
                pending.delete(frame.requestId);
                refreshIdleDeadline();
            });
    });
    return new Response(null, { status: 101, webSocket: client });
}
