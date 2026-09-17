import { Hono } from "hono";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { errorMiddleware, rethrowHttpError } from "../../../middleware/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { serverTiming } from "../../../middleware/server-timing.ts";
import { authenticatedSession } from "../../management/http/authenticated-session.ts";
import { MobiusAppError } from "../service/mobius-app-service.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const sessionInput = v.pipe(
    v.object({
        botId: identifier,
        sessionId: identifier,
        title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    }),
    v.readonly(),
);
const renameInput = v.pipe(
    v.object({ title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)) }),
    v.readonly(),
);

function notFound(): never {
    throw new MobiusAppError("NOT_FOUND", "Not found.", 404);
}

export function createChatApplication() {
    return new Hono<ChatHttpEnvironment>()
        .basePath("/mobius-cloud/api/chat/projects/:projectId")
        .onError(rethrowHttpError)
        .use(
            "*",
            serverTiming<ChatHttpEnvironment>({
                event: "chat-request-timing",
                message: "Chat request timing",
            }),
        )
        .use(
            "*",
            errorMiddleware<ChatHttpEnvironment>((context) => context.env.logger),
        )
        .use("*", requestHeaders)
        .route("/", createBotChatRoutes())
        .post("/bots/:botId/access-tokens", authenticatedSession, async (context) => {
            const session = context.get("session");
            const botId = v.parse(identifier, context.req.param("botId"));
            return json(
                await context.env.services.chat.issueAccessToken(session.userId, botId, context.req.raw.signal),
                201,
            );
        })
        .delete("/access-tokens/:accessTokenId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const accessTokenId = v.parse(identifier, context.req.param("accessTokenId"));
            await context.env.services.chat.revokeAccessToken(session.userId, accessTokenId, context.req.raw.signal);
            return new Response(null, { status: 204 });
        })
        .get("/sessions", authenticatedSession, async (context) => {
            const session = context.get("session");
            return json({
                sessions: await context.env.services.chat.listSessions(session.userId, context.req.raw.signal),
            });
        })
        .post(
            "/sessions",
            authenticatedSession,
            bodyParser<ChatHttpEnvironment, typeof sessionInput>(sessionInput),
            async (context) => {
                const session = context.get("session");
                const input = context.req.valid("json");
                const saved = await context.env.services.chat.saveSession(
                    session.userId,
                    input,
                    context.req.raw.signal,
                );
                return saved ? json(input, 201) : notFound();
            },
        )
        .patch(
            "/sessions/:sessionId",
            authenticatedSession,
            bodyParser<ChatHttpEnvironment, typeof renameInput>(renameInput),
            async (context) => {
                const session = context.get("session");
                const input = context.req.valid("json");
                const renamed = await context.env.services.chat.renameSession(
                    session.userId,
                    context.req.param("sessionId"),
                    input.title,
                    context.req.raw.signal,
                );
                return renamed ? json({ sessionId: context.req.param("sessionId"), title: input.title }) : notFound();
            },
        )
        .delete("/sessions/:sessionId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const deleted = await context.env.services.chat.deleteSession(
                session.userId,
                context.req.param("sessionId"),
                context.req.raw.signal,
            );
            return deleted ? new Response(null, { status: 204 }) : notFound();
        });
}
