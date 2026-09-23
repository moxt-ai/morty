import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import type { Session } from "../../management/entity/authentication/session.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";
import { authenticatedSession } from "../../management/http/authenticated-session.ts";
import type { ChatScope } from "../service/chat-service.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";
import { openBotRuntimeChannel } from "./runtime-channel.ts";

const setupInput = v.strictObject({ runtimeId: platformIdentifier, agentRef: platformIdentifier });
const agentSettingsInput = v.strictObject({ agentRef: platformIdentifier });
const sessionInput = v.strictObject({ sessionId: platformIdentifier });
const localSessionInput = v.variant("action", [
    v.strictObject({ action: v.literal("create") }),
    v.strictObject({
        action: v.literal("import"),
        sessionId: platformIdentifier,
    }),
]);

type AuthorizedChatEnvironment = ChatHttpEnvironment & {
    readonly Variables: ChatHttpEnvironment["Variables"] & {
        readonly session: Session;
        readonly chatScope: ChatScope;
    };
};

function authorizedChat(timeout = 45_000) {
    return createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
        const { userId } = context.get("session");
        const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)]);
        const projectId = v.parse(platformIdentifier, context.req.param("projectId"));
        const botId = v.parse(platformIdentifier, context.req.param("botId"));
        context.set(
            "chatScope",
            await context.env.services.chat.authorize(userId, projectId, botId, signal, context.get("operationTiming")),
        );
        await next();
    });
}

function privateJson(value: unknown) {
    const response = json(value);
    response.headers.set("Cache-Control", "no-store");
    return response;
}

export function createBotChatRoutes() {
    return new Hono<AuthorizedChatEnvironment>()
        .use(
            "*",
            bodyLimit({
                maxSize: 6_500_000,
                onError: () => {
                    throw new PlatformProjectError("INVALID_REQUEST", "The message is too large.", 413);
                },
            }),
        )
        .post("/bots/:botId/workspace", authenticatedSession, authorizedChat(), async (context) =>
            privateJson(await context.env.services.chat.workspace(context.get("chatScope"))),
        )
        .post(
            "/bots/:botId/agent-settings",
            authenticatedSession,
            authorizedChat(120_000),
            bodyParser<AuthorizedChatEnvironment, typeof agentSettingsInput>(agentSettingsInput),
            async (context) =>
                privateJson(
                    await context.env.services.chat.agentSettings(
                        context.get("chatScope"),
                        context.req.valid("json").agentRef,
                    ),
                ),
        )
        .post("/bots/:botId/local-runtime", authenticatedSession, authorizedChat(), async (context) =>
            privateJson(await context.env.services.chat.localRuntime(context.get("chatScope"))),
        )
        .post("/bots/:botId/local-sessions", authenticatedSession, authorizedChat(), async (context) =>
            privateJson(await context.env.services.chat.localSessions(context.get("chatScope"))),
        )
        .post(
            "/bots/:botId/local-sessions/create",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof localSessionInput>(localSessionInput),
            async (context) =>
                privateJson(
                    await context.env.services.chat.createLocalSession(
                        context.get("chatScope"),
                        context.req.valid("json"),
                    ),
                ),
        )
        .post(
            "/bots/:botId/local-session-access",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof sessionInput>(sessionInput),
            async (context) =>
                privateJson({
                    configuration: await context.env.services.chat.requireLocalSession(
                        context.get("chatScope"),
                        context.req.valid("json").sessionId,
                    ),
                }),
        )
        .get(
            "/bots/:botId/runtime-channel",
            async (context) =>
                await openBotRuntimeChannel({
                    request: context.req.raw,
                    projectId: context.req.param("projectId") ?? "",
                    botId: context.req.param("botId"),
                    dependencies: context.env,
                    timing: context.get("operationTiming"),
                }),
        )
        .post(
            "/bots/:botId/setup",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof setupInput>(setupInput),
            async (context) =>
                json(
                    await context.env.services.chat.configureBot(context.get("chatScope"), context.req.valid("json")),
                    202,
                ),
        );
}
