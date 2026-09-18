import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import { platformIdentifier, platformProjectSchema } from "./components/management/entity/platform-project.ts";
import { slackWorker } from "./components/slack/composition/cloudflare-slack-worker.ts";
import { slackRoutes } from "./components/slack/http/index.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { setupArtifact } from "./gateway/setup-artifact.ts";
import { createWebSocketApiBridge } from "./gateway/websocket-api-bridge.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { instrumentD1Database, RequestAccessMetrics } from "./infra/request-access-metrics.ts";
import { RequestError } from "./infra/request-error.ts";
import { errorMiddleware, rethrowHttpError } from "./middleware/error-middleware.ts";

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
        throw new RequestError("PROJECT_CONTEXT_MISMATCH", "The Project context is invalid.", 400);
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
    .use("/mobius-cloud/api/*", bodyLimit({ maxSize: 110000 }))
    .all("/mobius-cloud/api", notFound)
    .all("/mobius-slack/api", notFound)
    .route("/", instructionDocumentRoutes)
    .route("/", setupArtifact)
    .get("/mobius-cloud/ws", (context) =>
        createWebSocketApiBridge(
            context.req.raw,
            async (request): Promise<Response> => await application.fetch(request, context.env),
            createApplicationDependencies(context.env).logger,
        ),
    )
    .post("/__project/bootstrap", (context) => bootstrapProject(context.req.raw, context.env))
    .route("/mobius-cloud/api", cloudRoutes)
    .route("/mobius-slack/api", slackRoutes)
    .notFound(notFound);

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        const metrics = new RequestAccessMetrics();
        const instrumented = {
            ...bindings,
            DATABASE: instrumentD1Database(bindings.DATABASE, metrics),
            requestAccessMetrics: metrics,
        };
        const response = await application.fetch(request, instrumented, context);
        return metrics.appendServerTiming(response);
    },
    async queue(batch, bindings): Promise<void> {
        await slackWorker.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, unknown>;
