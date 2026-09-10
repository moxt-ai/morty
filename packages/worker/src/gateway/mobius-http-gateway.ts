import * as v from "valibot";
import { json } from "../infra/http.ts";

const forwardedHeaders = [
    "authorization",
    "accept",
    "content-type",
    "last-event-id",
    "range",
    "if-none-match",
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
];

export class MobiusHttpGateway {
    readonly #baseUrl: unknown;
    readonly #forbiddenOrigin: unknown;
    constructor(baseUrl: unknown, forbiddenOrigin?: unknown) {
        this.#baseUrl = baseUrl;
        this.#forbiddenOrigin = forbiddenOrigin;
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        request.signal.throwIfAborted();
        const incoming = new URL(request.url);
        let upstream: URL;
        try {
            upstream = new URL(v.parse(v.string(), this.#baseUrl));
            if (
                (upstream.protocol !== "https:" &&
                    !(
                        upstream.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname)
                    )) ||
                upstream.username ||
                upstream.password ||
                upstream.search ||
                upstream.hash ||
                upstream.pathname !== "/" ||
                upstream.origin === incoming.origin ||
                (typeof this.#forbiddenOrigin === "string" && upstream.origin === new URL(this.#forbiddenOrigin).origin)
            ) {
                throw new Error("Invalid upstream");
            }
        } catch {
            return json({ error: { code: "MOBIUS_UNAVAILABLE", message: "Mobius service is not configured." } }, 503);
        }
        if (!incoming.pathname.startsWith("/mobius/api/")) {
            return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
        }
        upstream.pathname = incoming.pathname;
        upstream.search = incoming.search;
        const headers = new Headers();
        for (const name of forwardedHeaders) {
            const value = request.headers.get(name);
            if (value !== null) {
                headers.set(name, value);
            }
        }
        const controller = new AbortController();
        const abort = () => controller.abort(request.signal.reason);
        request.signal.addEventListener("abort", abort, { once: true });
        let timer = setTimeout(
            () => controller.abort(new DOMException("Mobius deadline exceeded", "TimeoutError")),
            15_000,
        );
        const cleanup = () => {
            clearTimeout(timer);
            request.signal.removeEventListener("abort", abort);
        };
        try {
            const forwarded = new Request(request, {
                headers,
                redirect: "manual",
                signal: controller.signal,
            });
            const response = await fetch(new Request(upstream, forwarded));
            clearTimeout(timer);
            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
                await response.body?.cancel();
                cleanup();
                return json(
                    {
                        error: {
                            code: "MOBIUS_BAD_GATEWAY",
                            message: "Mobius service returned an unexpected redirect.",
                        },
                    },
                    502,
                );
            }
            if (response.status === 101 || response.body === null) {
                cleanup();
                return response;
            }
            const reader = response.body.getReader();
            const body = new ReadableStream<Uint8Array>({
                async pull(stream) {
                    timer = setTimeout(
                        () =>
                            controller.abort(new DOMException("Mobius stream idle deadline exceeded", "TimeoutError")),
                        45_000,
                    );
                    try {
                        const chunk = await reader.read();
                        clearTimeout(timer);
                        if (chunk.done) {
                            cleanup();
                            reader.releaseLock();
                            stream.close();
                        } else {
                            stream.enqueue(chunk.value);
                        }
                    } catch (cause) {
                        cleanup();
                        reader.releaseLock();
                        stream.error(cause);
                    }
                },
                async cancel(reason) {
                    cleanup();
                    controller.abort(reason);
                    try {
                        await reader.cancel(reason);
                    } finally {
                        reader.releaseLock();
                    }
                },
            });
            return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (cause) {
            cleanup();
            request.signal.throwIfAborted();
            const timeout = controller.signal.aborted;
            console.error("Mobius upstream request failed", { cause });
            return json(
                {
                    error: {
                        code: timeout ? "MOBIUS_TIMEOUT" : "MOBIUS_BAD_GATEWAY",
                        message: timeout ? "Mobius service did not respond in time." : "Mobius service is unavailable.",
                    },
                },
                timeout ? 504 : 502,
            );
        }
    };
}
