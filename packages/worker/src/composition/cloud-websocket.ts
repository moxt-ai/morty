import * as v from "valibot";
import { RequestError } from "../infra/request-error.ts";
import type { WebSocketBridgeHandlers, WebSocketBridgeRequest } from "../infra/websocket-api-bridge.ts";

const BRIDGE_ORIGIN = "https://bridge.internal";
const WATCH_INTERVAL_MILLISECONDS = 5_000;
const WATCH_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const permittedHeaders = new Set([
    "authorization",
    "content-type",
    "x-mobius-byte-length",
    "x-mobius-content-kind",
    "x-mobius-file-name",
]);
const STATUS_SUBSCRIPTION_PATH =
    /^\/morty\/api\/chat\/projects\/([^/]+)\/bots\/([^/]+)\/managed-session\/status-events$/u;
const statusSubscriptionPath = v.pipe(v.string(), v.regex(STATUS_SUBSCRIPTION_PATH));

interface CloudWebSocketDependencies {
    readonly dispatch: (request: Request) => Promise<Response>;
    readonly logger: { readonly error: (value: unknown, message: string) => void };
}

/** The resources a watch may follow: a Machine's workspace and its Runtime binding. */
function isWatchable(method: string, pathname: string): boolean {
    return (
        (method === "POST" && pathname.endsWith("/workspace")) ||
        (method === "GET" && pathname.endsWith("/runtime-binding"))
    );
}

function invalidBridgeRequest(): never {
    throw new RequestError("INVALID_BRIDGE_REQUEST", "The bridged request is invalid.", 400);
}

function bridgedUrl(path: string): URL {
    const url = new URL(path, BRIDGE_ORIGIN);
    if (url.origin !== BRIDGE_ORIGIN || !url.pathname.startsWith("/morty/api/")) {
        return invalidBridgeRequest();
    }
    return url;
}

function bridgedHeaders(values: readonly (readonly [string, string])[]): Headers {
    const headers = new Headers();
    for (const [untrustedName, value] of values) {
        const name = untrustedName.toLowerCase();
        if (!permittedHeaders.has(name) || headers.has(name) || value.includes("\r") || value.includes("\n")) {
            return invalidBridgeRequest();
        }
        headers.set(name, value);
    }
    return headers;
}

function resolveRequest(
    input: WebSocketBridgeRequest,
    operation: "request" | "subscribe" | "watch",
    signal: AbortSignal,
): Request {
    const url = bridgedUrl(input.path);
    const headers = bridgedHeaders(input.headers);
    const body = input.body === "" ? null : input.body;
    const requestBody = body instanceof Uint8Array ? body.slice().buffer : body;
    if (operation === "watch" && (!isWatchable(input.method, url.pathname) || body !== null)) {
        return invalidBridgeRequest();
    }
    if (
        operation === "subscribe" &&
        (input.method !== "POST" || !v.safeParse(statusSubscriptionPath, url.pathname).success)
    ) {
        return invalidBridgeRequest();
    }
    return new Request(url, {
        method: input.method,
        headers,
        signal,
        ...(requestBody === null ? {} : { body: requestBody }),
    });
}

async function subscribeSessionStatuses(
    request: Request,
    observer: { readonly publish: (data: string) => void },
    dependencies: CloudWebSocketDependencies,
    signal: AbortSignal,
): Promise<void> {
    const response = await dependencies.dispatch(request);
    if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new RequestError(
            "STATUS_SUBSCRIPTION_UNAVAILABLE",
            "Session status updates are unavailable.",
            response.status,
        );
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    try {
        while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            if (result.done) {
                break;
            }
            buffered += result.value;
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
                if (line !== "") {
                    observer.publish(line);
                }
            }
        }
    } finally {
        await reader.cancel(signal.aborted ? signal.reason : undefined);
        reader.releaseLock();
    }
}

async function waitForNextWatch(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const completed = () => {
            signal.removeEventListener("abort", aborted);
            resolve();
        };
        const timer = setTimeout(completed, WATCH_INTERVAL_MILLISECONDS);
        const aborted = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
    });
}

export function createCloudWebSocketHandlers(dependencies: CloudWebSocketDependencies): WebSocketBridgeHandlers {
    return {
        dispatch: dependencies.dispatch,
        resolve: resolveRequest,
        subscribe: async (request, observer, signal, baseline) => {
            if (request.url.endsWith("/managed-session/status-events")) {
                await subscribeSessionStatuses(request, observer, dependencies, signal);
                return;
            }
            // Compare the first sample with the configuration the client read,
            // not a fresh baseline that could already include an unseen change.
            // This is notification state only; every sample is still dispatched
            // through the normal authorization boundary.
            let fingerprint: string | null = baseline ?? null;
            while (!signal.aborted) {
                const deadline = AbortSignal.timeout(WATCH_REQUEST_TIMEOUT_MILLISECONDS);
                const requestSignal = AbortSignal.any([signal, deadline]);
                try {
                    const response = await dependencies.dispatch(new Request(request, { signal: requestSignal }));
                    if (response.status === 429 || response.status >= 500) {
                        await response.body?.cancel();
                        await waitForNextWatch(signal);
                        continue;
                    }
                    const body = await response.text();
                    requestSignal.throwIfAborted();
                    const next = `${response.status}\u0000${body}`;
                    if (fingerprint !== null && fingerprint !== next) {
                        observer.notify();
                        return;
                    }
                    if (fingerprint === null) {
                        observer.ready(response, body);
                    }
                    fingerprint = next;
                } catch (cause) {
                    signal.throwIfAborted();
                    dependencies.logger.error({ err: cause }, "WebSocket bridge watch failed");
                }
                await waitForNextWatch(signal);
            }
        },
    };
}
