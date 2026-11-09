import * as v from "valibot";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { systemClock } from "../time/clock.ts";
import type { ApiResponseSnapshot } from "./api-transport.ts";

export class ApiConnectionError extends Error {}
export function isApiConnectionError(error: unknown): error is ApiConnectionError {
    return error instanceof ApiConnectionError;
}
const mortyHealthSchema = v.strictObject({ service: v.literal("morty-relay"), status: v.literal("ok") });
function isWatchable(method: string, pathname: string): boolean {
    return (
        (method === "POST" && pathname.endsWith("/workspace")) ||
        (method === "GET" && pathname.endsWith("/runtime-binding")) ||
        (method === "GET" && pathname.endsWith("/identity/devices"))
    );
}

export class HttpApiTransport {
    readonly #origin: string;
    readonly #baselines = new Map<string, string>();
    readonly #lifetime = new AbortController();
    constructor(origin: string) {
        this.#origin = origin;
    }
    readonly dispose = (reason?: Error) => this.#lifetime.abort(reason);
    readonly #key = (request: Request) => JSON.stringify([request.url, request.headers.get("authorization")]);
    readonly fetch = async (request: Request): Promise<Response> => {
        const requestId = crypto.randomUUID();
        const started = performance.now();
        const operation = new URL(request.url).pathname.split("/").slice(-1)[0] ?? "request";
        try {
            if (new URL(request.url).origin !== this.#origin) {
                throw new Error("Unexpected Morty API origin.");
            }
            const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
            signal.throwIfAborted();
            const raw = await fetch(new Request(request, { signal }));
            const response = new Response(raw.body, raw);
            if (isWatchable(request.method, new URL(request.url).pathname)) {
                this.#baselines.set(this.#key(request), `${response.status}\0${await response.clone().text()}`);
            }
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
            if (request.signal.aborted) {
                throw request.signal.reason;
            }
            throw new ApiConnectionError("Unable to reach Morty.", { cause });
        }
    };
    readonly measureRelayLatency = async (origin: string, parent: AbortSignal): Promise<number> => {
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
            throw new Error("The Morty relay diagnostic endpoint is invalid.");
        }
        endpoint.pathname = "/morty/api/dashboard/health";
        endpoint.searchParams.set("diagnostic", crypto.randomUUID());
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
        const startedAt = performance.now();
        const response = await fetch(endpoint, { cache: "no-store", signal });
        signal.throwIfAborted();
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error("The Morty relay did not respond to the network diagnostic.");
        }
        v.parse(mortyHealthSchema, await response.json());
        return Math.max(0, Math.round(performance.now() - startedAt));
    };

    readonly measureMortyLatency = async (parent: AbortSignal) => {
        const start = performance.now();
        const response = await fetch(new URL("/morty/api/health", this.#origin), {
            cache: "no-store",
            signal: AbortSignal.any([parent, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) {
            throw new ApiConnectionError("Morty did not respond.");
        }
        return Math.round(performance.now() - start);
    };
    readonly waitForChange = async (request: Request, ready?: (snapshot: ApiResponseSnapshot) => void) => {
        const url = new URL(request.url);
        if (url.origin !== this.#origin || !isWatchable(request.method, url.pathname)) {
            throw new Error("Invalid Morty watch request.");
        }
        const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
        let baseline = ready ? undefined : this.#baselines.get(this.#key(request));
        while (true) {
            signal.throwIfAborted();
            let response: Response;
            try {
                response = await fetch(request.url, {
                    method: request.method,
                    headers: request.headers,
                    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
                });
            } catch (cause) {
                signal.throwIfAborted();
                if (ready !== undefined) {
                    throw new ApiConnectionError("Unable to reach Morty.", { cause });
                }
                await systemClock.sleep(5000, signal);
                continue;
            }
            if (response.status < 500 && response.status !== 429) {
                const body = await response.text();
                signal.throwIfAborted();
                const value = `${response.status}\0${body}`;
                if (baseline !== undefined && baseline !== value) {
                    return;
                }
                if (baseline === undefined) {
                    ready?.({ status: response.status, headers: response.headers, body });
                }
                if (response.status === 401 || response.status === 403) {
                    return;
                }
                baseline = value;
            } else {
                await response.body?.cancel();
            }
            await systemClock.sleep(5000, signal);
        }
    };
}
