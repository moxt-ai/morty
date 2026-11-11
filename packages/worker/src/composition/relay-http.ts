import {
    errorMiddleware,
    instrumentD1Database,
    RequestAccessMetrics,
    relayErrorHandler,
    requestTimeoutMiddleware,
} from "@morty-build/relay";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { routeComputerDurableObject } from "../gateway/computer-durable-object-routing.ts";
import { routeComputerSessionRequest } from "../gateway/computer-session-routing.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { relayAuthenticationFromEnvironment } from "./relay-authentication-environment.ts";
import { type ConfiguredRelayBindings, relayBindings } from "./relay-bindings.ts";
import {
    type ComputerExecution,
    composeRelayContext,
    createHostedRelayAccess,
    createRelayPorts,
} from "./relay-services.ts";

type RequestMetricsEnvironment = {
    readonly Variables: { readonly relayMetrics: RequestAccessMetrics };
};
type PublicEnvironment = RelayHttpEnvironment & RequestMetricsEnvironment & { readonly Bindings: CloudBindings };
type ComputerEnvironment = RelayHttpEnvironment &
    RequestMetricsEnvironment & {
        readonly Bindings: ConfiguredRelayBindings & { readonly execution: ComputerExecution };
    };

const measureRequest: MiddlewareHandler<RequestMetricsEnvironment> = async (context, next) => {
    const metrics = new RequestAccessMetrics();
    context.set("relayMetrics", metrics);
    await next();
    context.res = metrics.appendServerTiming(context.res);
};

function setRelayContext<E extends RelayHttpEnvironment>(
    context: Context<E>,
    bindings: ConfiguredRelayBindings,
    metrics: RequestAccessMetrics,
    execution: ComputerExecution | null,
) {
    const instrumented = {
        ...bindings,
        RELAY_DIRECTORY_DATABASE: instrumentD1Database(bindings.RELAY_DIRECTORY_DATABASE, metrics),
    };
    const access = createHostedRelayAccess(instrumented, execution);
    context.set("sessionAccess", access.sessionAccess);
    context.set("relay", composeRelayContext(access, createRelayPorts(instrumented, execution)));
    context.set(
        "sessionExecution",
        execution === null ? { kind: "remote" } : { kind: "local", operations: execution.operations },
    );
}

export function createPublicRelayRoutes() {
    const initialize: MiddlewareHandler<PublicEnvironment> = async (context, next) => {
        const bindings = relayBindings(context.env);
        const authentication = relayAuthenticationFromEnvironment(bindings);
        const routed =
            (await routeComputerSessionRequest(context.req.raw, bindings)) ??
            (await routeComputerDurableObject(context.req.raw, bindings, authentication.allowedOrigins));
        if (routed !== null) {
            return routed;
        }
        context.set("allowedOrigins", authentication.allowedOrigins);
        setRelayContext(context, bindings, context.var.relayMetrics, null);
        await next();
        return;
    };
    const timeout = requestTimeoutMiddleware<PublicEnvironment>(30_000);
    return new Hono<PublicEnvironment>()
        .onError(relayErrorHandler)
        .use("/morty/api/v1/*", measureRequest, errorMiddleware, timeout, initialize)
        .use("/morty/api/channels/*", measureRequest, errorMiddleware, timeout, initialize)
        .route("/", createRelayRoutes());
}

/** Computer-targeted requests never pass through public dispatch again. Authorization still runs in the routes. */
export function createComputerRelayRoutes() {
    return new Hono<ComputerEnvironment>()
        .onError(relayErrorHandler)
        .use("*", measureRequest, errorMiddleware)
        .use("*", requestTimeoutMiddleware<ComputerEnvironment>(30_000))
        .use("*", async (context, next) => {
            context.set("allowedOrigins", relayAuthenticationFromEnvironment(context.env).allowedOrigins);
            setRelayContext(context, context.env, context.var.relayMetrics, context.env.execution);
            await next();
        })
        .route("/", createRelayRoutes());
}

import { createRelayRoutes, type RelayHttpEnvironment } from "@morty-build/relay/http";
