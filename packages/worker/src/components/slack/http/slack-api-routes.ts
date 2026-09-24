import { Hono } from "hono";
import { errorMiddleware, rethrowHttpError } from "../../../middleware/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createSlackBotToolRoutes } from "./bot-tools/slack-bot-tool-routes.ts";
import { createSlackEventsRoutes } from "./events/slack-events-routes.ts";
import { createHealthRoutes } from "./health/health-routes.ts";
import { createSlackManagementRoutes } from "./installation/slack-management-routes.ts";
import type { SlackHttpEnvironment } from "./slack-http-environment.ts";

export function createSlackApplication() {
    return new Hono<SlackHttpEnvironment>()
        .basePath("/mobius-slack/api")
        .onError(rethrowHttpError)
        .use(
            "*",
            errorMiddleware<SlackHttpEnvironment>((context) => context.env.logger),
        )
        .use("*", requestHeaders)
        .route("/", createHealthRoutes())
        .route("/slack", createSlackEventsRoutes())
        .route("/slack", createSlackManagementRoutes())
        .route("/bot/slack", createSlackBotToolRoutes());
}
