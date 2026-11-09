import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import {
    clientLocationHeader,
    clientLocationOf,
    encodeClientLocation,
} from "./components/management/entity/client-location.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { publicCloudRoutes } from "./composition/cloud-http.ts";
import { computerApplication } from "./computer-application.ts";
import { setupArtifact } from "./gateway/setup-artifact.ts";
import { notFoundPage, webPages } from "./gateway/web-pages.ts";
import { type CloudBindings, webSocketNamespaceBindingSchema } from "./infra/cloud-bindings.ts";
import { RequestError } from "./infra/request-error.ts";
import { errorHandler } from "./middleware/error-middleware.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const application: Hono<{ readonly Bindings: CloudBindings }> = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(
        errorHandler<{ readonly Bindings: CloudBindings }>(
            (context) => createApplicationDependencies(context.env).logger,
        ),
    )
    .use("/morty/api/*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }))
    .all("/morty/api", notFound)
    .route("/", instructionDocumentRoutes)
    .route("/", setupArtifact)
    .get("/morty/ws", (context) => {
        const namespace = v.parse(webSocketNamespaceBindingSchema, context.env.CHAT_WEBSOCKETS);
        // The bridge learns where the browser connected from only here, from Cloudflare, never from the browser.
        const headers = new Headers(context.req.raw.headers);
        const location = clientLocationOf(context.req.raw);
        if (location === null) {
            headers.delete(clientLocationHeader);
        } else {
            headers.set(clientLocationHeader, encodeClientLocation(location));
        }
        return namespace.get(namespace.newUniqueId()).fetch(new Request(context.req.raw, { headers }));
    })
    .route("/", computerApplication)
    .notFound(notFound);

const publicApplication = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(
        errorHandler<{ readonly Bindings: CloudBindings }>(
            (context) => createApplicationDependencies(context.env).logger,
        ),
    )
    .use("/morty/api/*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }))
    .route("/", webPages)
    .route("/", instructionDocumentRoutes)
    .route("/", setupArtifact)
    .get("/morty/ws", (context) => application.fetch(context.req.raw, context.env))
    .route("/morty/api", publicCloudRoutes)
    .notFound((context) => notFoundPage(context.req.raw) ?? notFound());

export async function fetchPublicApplication(
    request: Request,
    bindings: CloudBindings,
    context?: ExecutionContext,
): Promise<Response> {
    return await publicApplication.fetch(request, bindings, context);
}

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        return await application.fetch(request, bindings, context);
    },
} satisfies ExportedHandler<CloudBindings, unknown>;
