import { Hono } from "hono";
import { createSlackBotToolRoutes } from "./bot-tools/slack-bot-tool-routes.ts";
import { handleError } from "./error-handler.ts";
import { createSlackEventsRoutes } from "./events/slack-events-routes.ts";
import { createHealthRoutes } from "./health/health-routes.ts";
import { createSlackManagementRoutes } from "./installation/slack-management-routes.ts";
import type { SlackHttpEnvironment } from "./slack-http-environment.ts";

export function createSlackApplication() {
    return new Hono<SlackHttpEnvironment>()
        .basePath("/mobius-slack/api")
        .onError(handleError)
        .route("/", createHealthRoutes())
        .route("/slack", createSlackEventsRoutes())
        .route("/slack", createSlackManagementRoutes())
        .route("/bot/slack", createSlackBotToolRoutes());
}
