import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clientLocationHeader, clientLocationOf, encodeClientLocation } from "../contracts/client-location.ts";
import type { CloudBindings } from "../contracts/cloud-bindings.ts";
import { relayAuthenticationFromEnvironment } from "../contracts/relay-authentication-environment.ts";
import { relayBindings } from "../contracts/relay-bindings.ts";
import { computerFromPath, computerFromRuntimeCredential, computerFromTransfer } from "../http/computer-target.ts";
import { errorHandler } from "../http/error-middleware.ts";
import { RequestError } from "../http/request-error.ts";
import { logger } from "../infra/logger.ts";
import { errorMiddleware, relayErrorHandler } from "../middleware/error-middleware.ts";
import { requestTimeoutMiddleware } from "../middleware/request-timeout-middleware.ts";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { forwardToComputer } from "./gateway/computer-object-routing.ts";
import { notFoundPage, webPages } from "./http/web-pages.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

type ForwardingEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly signal: AbortSignal; readonly computerId?: string };
};

/** Worker dispatch only. The owning DO defines and authorizes the actual endpoints. */
function createComputerForwardingRoutes() {
    const forward: MiddlewareHandler<ForwardingEnvironment> = async (context, next) => {
        const computerId = context.var.computerId;
        if (computerId === undefined) {
            await next();
            return;
        }
        const authentication = relayAuthenticationFromEnvironment(relayBindings(context.env));
        const origin = context.req.header("origin");
        if (
            origin !== undefined &&
            !authentication.allowedOrigins.has("*") &&
            !authentication.allowedOrigins.has(origin)
        ) {
            return context.json(
                { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
                403,
            );
        }
        return await forwardToComputer(context.req.raw, context.env, computerId);
    };
    return new Hono<ForwardingEnvironment>()
        .onError(relayErrorHandler)
        .use("/morty/api/*", errorMiddleware, requestTimeoutMiddleware<ForwardingEnvironment>(30_000))
        .get("/morty/api/v1/computers/connect", computerFromRuntimeCredential, forward)
        .use("/morty/api/computers/:computerId/*", computerFromPath)
        .use("/morty/api/v1/computers/:computerId/*", computerFromPath)
        .use("/morty/api/chat/computers/:computerId/*", computerFromPath)
        .use("/morty/api/identity/transfers/redeem", computerFromTransfer)
        .use("/morty/api/v1/pairings/:computerId/redeem", computerFromPath)
        .use("/morty/api/channels/:computerId/catalog", computerFromPath)
        .use("/morty/api/*", forward);
}

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const publicApplication = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(errorHandler<{ readonly Bindings: CloudBindings }>(() => logger))
    .use("/morty/api/identity/transfers/redeem", async (context, next) => {
        const headers = new Headers(context.req.raw.headers);
        const location = clientLocationOf(context.req.raw);
        headers.delete(clientLocationHeader);
        if (location !== null) {
            headers.set(clientLocationHeader, encodeClientLocation(location));
        }
        context.req.raw = new Request(context.req.raw, { headers });
        await next();
    })
    .route("/", createComputerForwardingRoutes())
    .use("/morty/api/*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }))
    .get("/morty/api/health", (context) => context.body(null, 204))
    .route("/", webPages)
    .route("/", instructionDocumentRoutes)
    .route("/morty/api", cloudRoutes)
    .notFound((context) => notFoundPage(context.req.raw) ?? notFound());

export async function fetchPublicApplication(
    request: Request,
    bindings: CloudBindings,
    context?: ExecutionContext,
): Promise<Response> {
    return await publicApplication.fetch(request, bindings, context);
}

export default { fetch: fetchPublicApplication } satisfies ExportedHandler<CloudBindings, unknown>;
