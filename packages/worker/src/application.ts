import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import { slackWorker } from "./components/slack/composition/cloudflare-slack-worker.ts";
import { slackRoutes } from "./components/slack/http/index.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { setupArtifact } from "./gateway/setup-artifact.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { instrumentD1Database, RequestAccessMetrics } from "./infra/request-access-metrics.ts";
import { RequestError } from "./infra/request-error.ts";
import { errorMiddleware, rethrowHttpError } from "./middleware/error-middleware.ts";

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const application = new Hono<{ readonly Bindings: CloudBindings }>()
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
    .route("/mobius-cloud/api", cloudRoutes)
    .route("/mobius-slack/api", slackRoutes)
    .notFound(notFound);

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        const metrics = new RequestAccessMetrics();
        const instrumented = {
            ...bindings,
            DATABASE: instrumentD1Database(bindings.DATABASE, metrics),
            CHAT_DATABASE_APAC: instrumentD1Database(bindings.CHAT_DATABASE_APAC, metrics),
            CHAT_DATABASE_WNAM: instrumentD1Database(bindings.CHAT_DATABASE_WNAM, metrics),
            requestAccessMetrics: metrics,
        };
        const response = await application.fetch(request, instrumented, context);
        return metrics.appendServerTiming(response);
    },
    async queue(batch, bindings): Promise<void> {
        await slackWorker.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, unknown>;
