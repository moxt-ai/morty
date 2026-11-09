import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

import { ComputerRelay as PlatformRuntimeRelay } from "../../../relay/src/durable-objects/computer-relay.ts";
import type { ConfiguredPlatformRelayBindings } from "../../../relay/src/platform-worker.ts";
import { errorMiddleware, rethrowHonoError } from "../../../relay-core/src/http/middleware/error-middleware.ts";
import platform from "../../src/platform-worker-entry.ts";

function failure(kind: string): unknown {
    if (kind === "primitive") {
        return "Non-Error failure";
    }
    if (kind === "object") {
        return { name: "RemoteFailure", message: "Remote queue exceeded", overloaded: true, secret: "PROPERTY_CANARY" };
    }
    const cause = Object.assign(new Error("Too many requests queued for the same Durable Object"), {
        overloaded: true,
        retryable: true,
        remote: true,
        code: "ERR_OVERLOADED",
    });
    const error = new Error("Runtime relay request failed", { cause });
    if (kind === "circular") {
        error.cause = error;
    }
    if (kind === "deep") {
        for (let depth = 0; depth < 12; depth += 1) {
            error.cause = new Error(`Nested failure ${depth}`, { cause: error.cause });
        }
    }
    if (kind === "getter") {
        Object.defineProperty(error, "message", {
            get: () => {
                throw new Error("Broken Error getter");
            },
        });
    }
    if (kind === "long") {
        error.message = "x".repeat(100_000);
    }
    if (kind === "secrets") {
        error.message =
            "Upstream https://user:PASSWORD_CANARY@relay.test/daemon?token=URL_CANARY failed Bearer ERROR_CANARY";
    }
    return error;
}

// The exported Cloudflare callback is the platform fault-injection boundary.
export class ComputerRelay extends PlatformRuntimeRelay {
    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await super.webSocketClose(socket, code, reason, wasClean);
        console.debug({ event: "test_websocket_close_completed", closeCode: code });
    }

    override async fetch(request: Request): Promise<Response> {
        if (
            request.headers.get("x-test-runtime-failure") === "1" &&
            new URL(request.url).pathname.endsWith("/daemon")
        ) {
            throw Object.assign(new Error("Runtime DO overloaded"), { overloaded: true });
        }
        if (new URL(request.url).pathname.endsWith("/inject-websocket-error")) {
            const socket = this.ctx.getWebSockets("daemon")[0];
            if (socket === undefined) {
                throw new Error("Expected a connected daemon");
            }
            this.webSocketError(socket, failure("nested"));
            return new Response(null, { status: 204 });
        }
        return await super.fetch(request);
    }
}

function projectOverload(): Error {
    return Object.assign(new Error("Project DO overloaded"), { overloaded: true });
}

export class UnavailableProject extends DurableObject {
    override fetch(): Response {
        throw projectOverload();
    }

    recordAudit(): never {
        throw projectOverload();
    }
}

interface TestBindings extends ConfiguredPlatformRelayBindings {
    // Stands in for COMPUTER_RELAY: every request and operation sent to it fails.
    readonly UNAVAILABLE_PROJECT: DurableObjectNamespace<ComputerRelay>;
}

const application = new Hono<{ Bindings: TestBindings }>()
    .use("*", errorMiddleware)
    .onError(rethrowHonoError)
    .post("/failure/:kind", (context) => {
        throw failure(context.req.param("kind"));
    })
    .all("/computers/:computerId/*", (context) =>
        context.env.COMPUTER_RELAY.getByName(context.req.param("computerId")).fetch(context.req.raw),
    );

export default {
    fetch: (request: Request, environment: TestBindings) => {
        if (new URL(request.url).pathname.startsWith("/morty/")) {
            return platform.fetch(
                request,
                request.headers.has("x-test-project-failure")
                    ? { ...environment, COMPUTER_RELAY: environment.UNAVAILABLE_PROJECT }
                    : environment,
            );
        }
        return application.fetch(request, environment);
    },
};
