import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { logger } from "../../../composition/application-context.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

export function createChatApplication(initialize: MiddlewareHandler<ChatHttpEnvironment>) {
    return new Hono<ChatHttpEnvironment>()
        .onError(errorHandler<ChatHttpEnvironment>((context) => context.var.application?.logger ?? logger))
        .use(
            "*",
            requestTimeoutMiddleware<ChatHttpEnvironment>(30_000),
            computerFromPath,
            bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
            initialize,
            requestHeaders,
        )
        .route("/", createBotChatRoutes());
}
