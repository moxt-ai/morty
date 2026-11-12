import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { logger } from "../../../composition/application-context.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import type { ManagementHttpEnvironment } from "../../management/http/management-http-environment.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";

export function createChatApplication(initialize: MiddlewareHandler<ManagementHttpEnvironment>) {
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler<ManagementHttpEnvironment>((context) => context.var.application?.logger ?? logger))
        .use(
            "*",
            requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
            computerFromPath,
            bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
            initialize,
            requestHeaders,
        )
        .route("/", createBotChatRoutes());
}
