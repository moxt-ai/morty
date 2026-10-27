import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import { platformIdentifier, platformProjectSchema } from "./components/management/entity/platform-project.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { cloudRoutes, publicCloudRoutes } from "./composition/cloud-http.ts";
import { createCloudWebSocketHandlers } from "./composition/cloud-websocket.ts";
import { setupArtifact } from "./gateway/setup-artifact.ts";
import { notFoundPage, webPages } from "./gateway/web-pages.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { RequestError } from "./infra/request-error.ts";
import { createWebSocketApiBridge } from "./infra/websocket-api-bridge.ts";
import { errorMiddleware, rethrowHttpError } from "./middleware/error-middleware.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const projectBootstrap = v.pipe(v.object({ project: platformProjectSchema, userId: platformIdentifier }), v.readonly());

async function bootstrapProject(request: Request, bindings: CloudBindings): Promise<Response> {
    const projectId = bindings.CHAT_PROJECT_ID;
    if (projectId === undefined) {
        return notFound();
    }
    const input: unknown = await request.json();
    const parsed = v.parse(projectBootstrap, input);
    if (parsed.project.projectId !== projectId) {
        throw new RequestError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const dependencies = createApplicationDependencies(bindings);
    return new Response(
        JSON.stringify(
            await dependencies.services.management.initializeAnonymousUser(parsed.userId, parsed.project, signal),
        ),
        {
            headers: { "Cache-Control": "no-store", "content-type": "application/json" },
            status: 201,
        },
    );
}

const application: Hono<{ readonly Bindings: CloudBindings }> = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(rethrowHttpError)
    .use(
        "*",
        errorMiddleware<{ readonly Bindings: CloudBindings }>(
            (context) => createApplicationDependencies(context.env).logger,
        ),
    )
    .use("/morty/api/*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }))
    .all("/morty/api", notFound)
    .route("/", instructionDocumentRoutes)
    .route("/", setupArtifact)
    .get("/morty/ws", (context) => {
        const logger = createApplicationDependencies(context.env).logger;
        return createWebSocketApiBridge(
            context.req.raw,
            createCloudWebSocketHandlers({
                dispatch: async (request): Promise<Response> => await application.fetch(request, context.env),
                logger,
            }),
            logger,
        );
    })
    .post("/__project/bootstrap", (context) => bootstrapProject(context.req.raw, context.env))
    .route("/morty/api", cloudRoutes)
    .notFound(notFound);

const publicApplication = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(rethrowHttpError)
    .use(
        "*",
        errorMiddleware<{ readonly Bindings: CloudBindings }>(
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
