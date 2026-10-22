import { Hono } from "hono";
import { errorMiddleware, rethrowHttpError } from "../../../middleware/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

export function createChatApplication() {
    return new Hono<ChatHttpEnvironment>()
        .basePath("/morty/api/chat/projects/:projectId")
        .onError(rethrowHttpError)
        .use(
            "*",
            errorMiddleware<ChatHttpEnvironment>((context) => context.env.logger),
        )
        .use("*", requestHeaders)
        .route("/", createBotChatRoutes());
}
