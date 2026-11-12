import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import type { ManagementHttpEnvironment } from "../../management/http/management-http-environment.ts";
import type { ManagementRouteContext } from "../../management/http/route-context.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";

export function createChatApplication(ctx: ManagementRouteContext) {
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler)
        .use(
            "*",
            requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
            computerFromPath,
            bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
        )
        .route("/", createBotChatRoutes(ctx));
}
