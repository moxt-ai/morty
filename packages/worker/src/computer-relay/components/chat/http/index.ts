import { Hono } from "hono";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

export function createChatApplication() {
    return new Hono<ChatHttpEnvironment>()
        .onError(errorHandler<ChatHttpEnvironment>((context) => context.var.application.logger))
        .use("*", requestHeaders)
        .route("/", createBotChatRoutes());
}
