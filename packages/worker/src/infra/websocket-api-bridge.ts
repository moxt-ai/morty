import { decodeContentChunkFrame } from "@moxt-ai/mobius-sdk/protocol";
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
    bodyByteLength: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(3 * 1_024 * 1_024))),
});
const watchFrame = v.strictObject({
    kind: v.literal("watch"),
    baseline: v.optional(v.pipe(v.string(), v.maxLength(7_000_000))),
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

interface BridgeLogger {
    readonly error: (value: unknown, message: string) => void;
}

export interface WebSocketBridgeRequest {
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly path: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string | Uint8Array | null;
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
        observer: {
            readonly ready: (response: Response, body: string) => void;
            readonly notify: () => void;
            readonly publish: (data: string) => void;
        },
        signal: AbortSignal,
        baseline?: string,
    ) => Promise<void>;
}

interface BinaryBridgeRequest {
    readonly body: Uint8Array;
    readonly byteLength: number;
    readonly controller: AbortController;
    readonly frame: WebSocketBridgeRequest;
    readonly requestId: string;
    receivedBytes: number;
    sequence: number;
}

function send(socket: WebSocket, value: Readonly<Record<string, unknown>>): void {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
    }
}

async function sendResponse(
    socket: WebSocket,
    requestIdValue: string,
    response: Response,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const body = response.body === null ? null : await response.text();
    signal.throwIfAborted();
    send(socket, {
        kind: "response",
        requestId: requestIdValue,
        status: response.status,
        headers: [...response.headers],
        body,
    });
}

function protocolError(socket: WebSocket, requestIdValue: string | null): void {
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
    const server = pair[1];
    const pending = new Map<string, AbortController>();
    const binaryRequests = new Map<string, BinaryBridgeRequest>();
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
        binaryRequests.clear();
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
            try {
                const chunk = decodeContentChunkFrame(event.data);
                const upload = binaryRequests.get(chunk.requestId);
                if (upload === undefined || chunk.sequence !== upload.sequence) {
                    throw new Error("The binary bridge chunk is not expected");
                }
                upload.sequence += 1;
                upload.receivedBytes += chunk.bytes.byteLength;
                if (upload.receivedBytes > upload.byteLength) {
                    throw new Error("The binary bridge request exceeds its declared size");
                }
                upload.body.set(chunk.bytes, upload.receivedBytes - chunk.bytes.byteLength);
                if (upload.receivedBytes === upload.byteLength) {
                    binaryRequests.delete(upload.requestId);
                    const signal = AbortSignal.any([
                        upload.controller.signal,
                        AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
                    ]);
                    let dispatchedRequest: Request;
                    try {
                        dispatchedRequest = handlers.resolve({ ...upload.frame, body: upload.body }, "request", signal);
                    } catch {
                        pending.delete(upload.requestId);
                        protocolError(server, upload.requestId);
                        return;
                    }
                    void handlers
                        .dispatch(dispatchedRequest)
                        .then(async (response) => {
                            await sendResponse(server, upload.requestId, response, signal);
                        })
                        .catch((cause: unknown) => {
                            if (!upload.controller.signal.aborted) {
                                const httpError = toHttpError(cause);
                                send(server, {
                                    kind: "error",
                                    requestId: upload.requestId,
                                    code: httpError.body.error.code,
                                    message: httpError.body.error.message,
                                });
                            }
                        })
                        .finally(() => {
                            pending.delete(upload.requestId);
                            refreshIdleDeadline();
                        });
                }
            } catch {
                protocolError(server, null);
            }
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
            pending.delete(frame.requestId);
            binaryRequests.delete(frame.requestId);
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
                        ready: (response, body) =>
                            send(server, {
                                kind: "watch.ready",
                                subscriptionId: frame.subscriptionId,
                                status: response.status,
                                headers: [...response.headers],
                                body,
                            }),
                        notify: () => send(server, { kind: "notification", subscriptionId: frame.subscriptionId }),
                        publish: (data) => send(server, { data, kind: "event", subscriptionId: frame.subscriptionId }),
                    },
                    lifetime.signal,
                    frame.kind === "watch" ? frame.baseline : undefined,
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
        if (frame.bodyByteLength !== undefined) {
            if (frame.body !== null) {
                protocolError(server, frame.requestId);
                return;
            }
            pending.set(frame.requestId, controller);
            binaryRequests.set(frame.requestId, {
                body: new Uint8Array(frame.bodyByteLength),
                byteLength: frame.bodyByteLength,
                controller,
                frame: {
                    body: null,
                    headers: frame.headers,
                    method: frame.method,
                    path: frame.path,
                },
                receivedBytes: 0,
                requestId: frame.requestId,
                sequence: 0,
            });
            return;
        }
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
