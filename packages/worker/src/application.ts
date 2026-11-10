import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import {
    clientLocationHeader,
    clientLocationOf,
    encodeClientLocation,
} from "./components/management/entity/client-location.ts";
import { logger } from "./composition/application-context.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { fetchPublicRelay } from "./gateway/local-relay.ts";
import { notFoundPage, webPages } from "./gateway/web-pages.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { RequestError } from "./infra/request-error.ts";
import { errorHandler } from "./middleware/error-middleware.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

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
    .route(
        "/morty/api/v1",
        new Hono<{ readonly Bindings: CloudBindings }>().all("*", (context) =>
            fetchPublicRelay(context.req.raw, context.env),
        ),
    )
    .route(
        "/morty/api/channels",
        new Hono<{ readonly Bindings: CloudBindings }>().all("*", (context) =>
            fetchPublicRelay(context.req.raw, context.env),
        ),
    )
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
