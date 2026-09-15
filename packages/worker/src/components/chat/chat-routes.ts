import { Hono } from "hono";
import * as v from "valibot";
import { json } from "../../infra/http.ts";
import { errorMiddleware, rethrowHttpError } from "../../middleware/error-middleware.ts";
import { requestHeaders } from "../../middleware/request-headers.ts";
import { authenticatedSession } from "../management/http/authenticated-session.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";
import { MobiusAppError } from "./mobius-app-service.ts";

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
        .basePath("/mobius-cloud/api/chat")
        .onError(rethrowHttpError)
        .use(
            "*",
            errorMiddleware<ChatHttpEnvironment>((context) => context.env.logger),
        )
        .use("*", requestHeaders)
        .route("/", createBotChatRoutes())
        .post("/bots/:botId/access-tokens", authenticatedSession, async (context) => {
            const session = context.get("session");
            const botId = v.parse(identifier, context.req.param("botId"));
            if (!(await context.env.storages.managedBots.ownsBot(session.userId, botId, context.req.raw.signal))) {
                return notFound();
            }
            const accessToken = await context.env.services.mobiusApp.issueAccessToken(
                botId,
                null,
                context.req.raw.signal,
            );
            try {
                await context.env.storages.managedBots.saveAccessToken(
                    session.userId,
                    botId,
                    accessToken.accessTokenId,
                    Date.now(),
                    context.req.raw.signal,
                );
            } catch (cause) {
                await context.env.services.mobiusApp.revokeAccessToken(
                    accessToken.accessTokenId,
                    AbortSignal.timeout(10_000),
                );
                context.req.raw.signal.throwIfAborted();
                throw cause;
            }
            return json(accessToken, 201);
        })
        .delete("/access-tokens/:accessTokenId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const accessTokenId = v.parse(identifier, context.req.param("accessTokenId"));
            if (
                !(await context.env.storages.managedBots.ownsAccessToken(
                    session.userId,
                    accessTokenId,
                    context.req.raw.signal,
                ))
            ) {
                return notFound();
            }
            await context.env.services.mobiusApp.revokeAccessToken(accessTokenId, context.req.raw.signal);
            await context.env.storages.managedBots.deleteAccessToken(
                session.userId,
                accessTokenId,
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        })
        .get("/sessions", authenticatedSession, async (context) => {
            const session = context.get("session");
            return json({
                sessions: await context.env.storages.managedBots.listSessions(session.userId, context.req.raw.signal),
            });
        })
        .post("/sessions", authenticatedSession, async (context) => {
            const session = context.get("session");
            const input = v.parse(sessionInput, await context.req.json());
            const saved = await context.env.storages.managedBots.saveSession(
                session.userId,
                input,
                Date.now(),
                context.req.raw.signal,
            );
            return saved ? json(input, 201) : notFound();
        })
        .patch("/sessions/:sessionId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const input = v.parse(renameInput, await context.req.json());
            const renamed = await context.env.storages.managedBots.renameSession(
                session.userId,
                context.req.param("sessionId"),
                input.title,
                Date.now(),
                context.req.raw.signal,
            );
            return renamed ? json({ sessionId: context.req.param("sessionId"), title: input.title }) : notFound();
        })
        .delete("/sessions/:sessionId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const deleted = await context.env.storages.managedBots.deleteSession(
                session.userId,
                context.req.param("sessionId"),
                context.req.raw.signal,
            );
            return deleted ? new Response(null, { status: 204 }) : notFound();
        });
}
