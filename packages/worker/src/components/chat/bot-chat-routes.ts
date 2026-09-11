import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../infra/http.ts";
import { PlatformProjectError, platformIdentifier } from "../management/entity/platform-project.ts";
import { authenticatedSession } from "../management/http/authenticated-session.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

const setupInput = v.strictObject({
    runtimeId: platformIdentifier,
    agentRef: platformIdentifier,
    workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    agentConfigRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export function createBotChatRoutes() {
    return new Hono<ChatHttpEnvironment>()
        .use(
            "*",
            bodyLimit({
                maxSize: 110000,
                onError: () => json({ error: { code: "INVALID_REQUEST", message: "The message is too large." } }, 413),
            }),
        )
        .all("/bots/:botId/:operation", async (context, next) => {
            const operation = context.req.param("operation");
            if (!["access", "setup", "workspace", "runtime-access"].includes(operation)) {
                return await next();
            }
            if (context.req.method !== "POST") {
                const response = json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405);
                response.headers.set("Allow", "POST");
                return response;
            }
            const session = await authenticatedSession(context.env, context.req.raw);
            if (session instanceof Response) {
                return session;
            }
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            const botId = v.parse(platformIdentifier, context.req.param("botId"));
            if (!(await context.env.storages.managedBots.ownsBot(session.userId, botId, signal))) {
                throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
            }
            const gateway = context.env.gateways.platformProjects;
            const { origin, appId } = gateway.configuration();
            const project = await context.env.storages.platformProjects.read(session.userId, origin, appId, signal);
            if (project === null) {
                throw new PlatformProjectError("BOT_UNAVAILABLE", "Your Bot is unavailable.", 409);
            }
            if (operation === "workspace") {
                const workspace = await gateway.chatWorkspace(project.projectId, botId, session.userId, signal);
                const response = json(workspace);
                response.headers.set("Cache-Control", "no-store");
                return response;
            }
            if (operation === "access") {
                const access = await gateway.openChat(project.projectId, botId, session.userId, signal);
                context.env.logger.info(
                    {
                        event: "bot-chat-access-issued",
                        userId: session.userId,
                        botId,
                        conversationId: access.conversationId,
                    },
                    "Chat audit event",
                );
                const response = json(access);
                response.headers.set("Cache-Control", "no-store");
                return response;
            }
            if (context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
                throw new PlatformProjectError("INVALID_REQUEST", "A JSON request is required.", 400);
            }
            let body: unknown;
            try {
                body = await context.req.json();
            } catch (cause) {
                signal.throwIfAborted();
                throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
            }
            if (operation === "runtime-access") {
                const input = v.parse(v.strictObject({ runtimeId: platformIdentifier }), body);
                const access = await gateway.runtimeBrowserAccess(project.projectId, input.runtimeId, signal);
                context.env.logger.info(
                    {
                        event: "runtime-browser-access-issued",
                        userId: session.userId,
                        botId,
                        runtimeId: input.runtimeId,
                    },
                    "Chat audit event",
                );
                const response = json(access);
                response.headers.set("Cache-Control", "no-store");
                return response;
            }
            const result = await gateway.configureBot(
                project.projectId,
                botId,
                session.userId,
                v.parse(setupInput, body),
                signal,
            );
            context.env.logger.info(
                { event: "bot-setup-requested", userId: session.userId, projectId: project.projectId, botId },
                "Bot audit event",
            );
            return json(result, 202);
        });
}
