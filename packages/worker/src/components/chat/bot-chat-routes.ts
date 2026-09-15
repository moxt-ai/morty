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
const nativeDirectoryId = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/u));
const nativeIdentity = {
    runtimeId: platformIdentifier,
    agentId: platformIdentifier,
    directoryId: nativeDirectoryId,
    additionalDirectoryIds: v.pipe(v.array(nativeDirectoryId), v.maxLength(16)),
};
const nativeInput = v.variant("action", [
    v.strictObject({
        ...nativeIdentity,
        action: v.literal("list"),
        cursor: v.nullable(platformIdentifier),
        discoveryId: v.nullable(platformIdentifier),
    }),
    v.strictObject({
        ...nativeIdentity,
        action: v.literal("import"),
        entryId: platformIdentifier,
        discoveryId: platformIdentifier,
    }),
]);

export function createBotChatRoutes() {
    return new Hono<ChatHttpEnvironment>()
        .use(
            "*",
            bodyLimit({
                maxSize: 110000,
                onError: () => json({ error: { code: "INVALID_REQUEST", message: "The message is too large." } }, 413),
            }),
        )
        .all(
            "/bots/:botId/:operation{access|setup|workspace|native-sessions|session-access|draft-settings}",
            async (context, next) => {
                if (context.req.method !== "POST") {
                    const response = json(
                        { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } },
                        405,
                    );
                    response.headers.set("Allow", "POST");
                    return response;
                }
                return await next();
            },
            authenticatedSession,
            async (context) => {
                const operation = context.req.param("operation");
                const session = context.get("session");
                const signal = AbortSignal.any([
                    context.req.raw.signal,
                    AbortSignal.timeout(
                        operation === "native-sessions" || operation === "draft-settings" ? 120000 : 45000,
                    ),
                ]);
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
                if (operation === "draft-settings") {
                    const settings = await gateway.draftSettings(project.projectId, botId, session.userId, signal);
                    context.env.logger.info(
                        { event: "chat-settings-prepared", userId: session.userId, botId },
                        "Chat audit event",
                    );
                    const response = json(settings);
                    response.headers.set("Cache-Control", "no-store");
                    return response;
                }
                if (operation === "access") {
                    const text = await context.req.text();
                    let body: unknown = {};
                    if (text !== "") {
                        try {
                            body = JSON.parse(text);
                        } catch (cause) {
                            signal.throwIfAborted();
                            throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, {
                                cause,
                            });
                        }
                    }
                    const input = v.parse(
                        v.union([
                            v.strictObject({ conversationId: platformIdentifier }),
                            v.strictObject({
                                conversationKey: platformIdentifier,
                                bindingId: platformIdentifier,
                                configuration: v.strictObject({
                                    additionalDirectoryIds: v.pipe(v.array(nativeDirectoryId), v.maxLength(16)),
                                    booleanValue: v.boolean(),
                                    configId: platformIdentifier,
                                    value: v.pipe(v.string(), v.maxLength(500)),
                                    valueType: v.picklist(["select", "boolean"]),
                                }),
                            }),
                        ]),
                        body,
                    );
                    const access = await gateway.openChat(project.projectId, botId, session.userId, signal, input);
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
                if (context.get("mediaType") !== "application/json") {
                    throw new PlatformProjectError("INVALID_REQUEST", "A JSON request is required.", 400);
                }
                let body: unknown;
                try {
                    body = await context.req.json();
                } catch (cause) {
                    signal.throwIfAborted();
                    throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
                }
                if (operation === "session-access") {
                    const input = v.parse(v.strictObject({ sessionId: platformIdentifier }), body);
                    const access = await gateway.nativeSessionAccess(project.projectId, input.sessionId, signal);
                    context.env.logger.info(
                        { event: "session-access-issued", userId: session.userId, botId, sessionId: input.sessionId },
                        "Chat audit event",
                    );
                    const response = json(access);
                    response.headers.set("Cache-Control", "no-store");
                    return response;
                }
                if (operation === "native-sessions") {
                    const { runtimeId, ...input } = v.parse(nativeInput, body);
                    const result = await gateway.nativeSessions(project.projectId, runtimeId, input, signal);
                    context.env.logger.info(
                        {
                            event: "native-session-operation",
                            userId: session.userId,
                            botId,
                            runtimeId,
                            action: input.action,
                        },
                        "Chat audit event",
                    );
                    const response = json(result);
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
            },
        );
}
