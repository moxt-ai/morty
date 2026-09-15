import { Hono } from "hono";
import { handleError } from "./http/error-handler";
import { createSlackEventsRoutes } from "./http/events/slack-events-routes";
import { createHealthRoutes } from "./http/health/health-routes";
import { createSlackManagementRoutes } from "./http/installation/slack-management-routes";
import type { SlackHttpEnvironment } from "./http/slack-http-environment";

const slackApiPrefix = "/mobius-slack/api";

export interface SlackRuntime<TEnvironment, TContext, TQueueBatch> {
    readonly fetchApi: (request: Request, environment: TEnvironment, context: TContext) => Promise<Response>;
    readonly fetchFile: (request: Request) => Promise<Response>;
    readonly consumeQueue: (batch: TQueueBatch) => Promise<void>;
}

export interface SlackWorker<TEnvironment, TContext, TQueueBatch> {
    readonly fetch: (request: Request, environment: TEnvironment, context: TContext) => Promise<Response>;
    readonly queue: (batch: TQueueBatch, environment: TEnvironment) => Promise<void>;
}

export function createSlackWorker<TEnvironment, TContext, TQueueBatch>(
    createRuntime: (environment: TEnvironment) => SlackRuntime<TEnvironment, TContext, TQueueBatch>,
): SlackWorker<TEnvironment, TContext, TQueueBatch> {
    return {
        fetch: async (request, environment, context) => {
            const pathname = new URL(request.url).pathname;
            if (!pathname.startsWith(`${slackApiPrefix}/`)) {
                return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
            }
            const runtime = createRuntime(environment);
            return pathname.startsWith(`${slackApiPrefix}/files/`)
                ? await runtime.fetchFile(request)
                : await runtime.fetchApi(request, environment, context);
        },
        queue: async (batch, environment) => await createRuntime(environment).consumeQueue(batch),
    };
}

export function createSlackApplication() {
    return new Hono<SlackHttpEnvironment>()
        .basePath(slackApiPrefix)
        .onError(handleError)
        .route("/", createHealthRoutes())
        .route("/slack", createSlackEventsRoutes())
        .route("/slack", createSlackManagementRoutes());
}
