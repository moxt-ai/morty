import { RequestError } from "../infra/request-error.ts";
import type { WebSocketBridgeHandlers, WebSocketBridgeRequest } from "../infra/websocket-api-bridge.ts";

const BRIDGE_ORIGIN = "https://bridge.internal";
const WATCH_INTERVAL_MILLISECONDS = 5_000;
const WATCH_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const permittedHeaders = new Set(["authorization", "content-type"]);

interface CloudWebSocketDependencies {
    readonly dispatch: (request: Request) => Promise<Response>;
    readonly logger: { readonly error: (value: unknown, message: string) => void };
}

function invalidBridgeRequest(): never {
    throw new RequestError("INVALID_BRIDGE_REQUEST", "The bridged request is invalid.", 400);
}

function bridgedUrl(path: string): URL {
    const url = new URL(path, BRIDGE_ORIGIN);
    if (
        url.origin !== BRIDGE_ORIGIN ||
        (!url.pathname.startsWith("/mobius-cloud/api/") && !url.pathname.startsWith("/mobius-slack/api/"))
    ) {
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

function resolveRequest(input: WebSocketBridgeRequest, operation: "request" | "watch", signal: AbortSignal): Request {
    const url = bridgedUrl(input.path);
    const headers = bridgedHeaders(input.headers);
    if (
        operation === "watch" &&
        (input.method !== "POST" || !url.pathname.endsWith("/workspace") || input.body !== null)
    ) {
        return invalidBridgeRequest();
    }
    return new Request(url, {
        method: input.method,
        headers,
        signal,
        ...(input.body === null ? {} : { body: input.body }),
    });
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
        subscribe: async (request, observer, signal) => {
            let fingerprint: string | null = null;
            while (!signal.aborted) {
                const deadline = AbortSignal.timeout(WATCH_REQUEST_TIMEOUT_MILLISECONDS);
                const requestSignal = AbortSignal.any([signal, deadline]);
                try {
                    const response = await dependencies.dispatch(new Request(request, { signal: requestSignal }));
                    const body = await response.text();
                    requestSignal.throwIfAborted();
                    const next = `${response.status}\u0000${body}`;
                    if (fingerprint !== null && fingerprint !== next) {
                        observer.notify();
                        return;
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
