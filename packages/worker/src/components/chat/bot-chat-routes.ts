import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../infra/http.ts";
import type { Session } from "../management/entity/authentication/session.ts";
import { PlatformProjectError, platformIdentifier } from "../management/entity/platform-project.ts";
import { authenticatedSession } from "../management/http/authenticated-session.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";
import { MobiusAppError } from "./mobius-app-service.ts";

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
const nativeListInput = v.strictObject({
    ...nativeIdentity,
    action: v.literal("list"),
    cursor: v.nullable(platformIdentifier),
    discoveryId: v.nullable(platformIdentifier),
});
const nativeEntryInput = v.strictObject({ ...nativeIdentity, discoveryId: platformIdentifier });
const accessInput = v.union([
    v.strictObject({ conversationId: platformIdentifier }),
    v.strictObject({
        conversationKey: platformIdentifier,
        bindingId: platformIdentifier,
        title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)), "New chat"),
        configuration: v.strictObject({
            additionalDirectoryIds: v.pipe(v.array(nativeDirectoryId), v.maxLength(16)),
            booleanValue: v.boolean(),
            configId: platformIdentifier,
            value: v.pipe(v.string(), v.maxLength(500)),
            valueType: v.picklist(["select", "boolean"]),
        }),
    }),
]);

type AuthenticatedChatEnvironment = ChatHttpEnvironment & { readonly Variables: { readonly session: Session } };

async function authorizeChat(context: Context<AuthenticatedChatEnvironment>, timeout = 45000) {
    const { userId } = context.get("session");
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)]);
    const projectId = v.parse(platformIdentifier, context.req.param("projectId"));
    const botId = v.parse(platformIdentifier, context.req.param("botId"));
    const [ownsProject, ownsBot] = await Promise.all([
        context.env.storages.identities.ownsProject(userId, projectId, signal),
        context.env.storages.managedBots.ownsBot(userId, botId, signal),
    ]);
    if (!ownsProject) {
        throw new PlatformProjectError("NOT_FOUND", "Your Project was not found.", 404);
    }
    if (!ownsBot) {
        throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
    }
    const gateway = context.env.gateways.platformProjects;
    return { userId, botId, projectId, gateway, signal };
}

async function readJson(context: Context<AuthenticatedChatEnvironment>, signal: AbortSignal): Promise<unknown> {
    if (context.get("mediaType") !== "application/json") {
        throw new PlatformProjectError("INVALID_REQUEST", "A JSON request is required.", 400);
    }
    try {
        const body: unknown = await context.req.json();
        signal.throwIfAborted();
        return body;
    } catch (cause) {
        signal.throwIfAborted();
        throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
    }
}

function privateJson(value: unknown) {
    const response = json(value);
    response.headers.set("Cache-Control", "no-store");
    return response;
}

export function createBotChatRoutes() {
    return new Hono<ChatHttpEnvironment>()
        .use(
            "*",
            bodyLimit({
                maxSize: 110000,
                onError: () => {
                    throw new MobiusAppError("INVALID_REQUEST", "The message is too large.", 413);
                },
            }),
        )
        .post("/bots/:botId/workspace", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context);
            return privateJson(await gateway.chatWorkspace(projectId, botId, userId, signal));
        })
        .post("/bots/:botId/managed-sessions", authenticatedSession, async (context) => {
            const { projectId, botId, userId, signal } = await authorizeChat(context);
            return privateJson({
                sessions: await context.env.storages.chatSessions.list(projectId, userId, botId, signal),
            });
        })
        .post("/bots/:botId/draft-settings", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context, 120000);
            const settings = await gateway.draftSettings(projectId, botId, userId, signal);
            context.env.logger.info({ event: "chat-settings-prepared", userId, projectId, botId }, "Chat audit event");
            return privateJson(settings);
        })
        .post("/bots/:botId/access", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context);
            const text = await context.req.text();
            let body: unknown = {};
            if (text !== "") {
                try {
                    body = JSON.parse(text);
                } catch (cause) {
                    signal.throwIfAborted();
                    throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
                }
            }
            const input = v.parse(accessInput, body);
            const access = await gateway.openChat(projectId, botId, userId, signal, input);
            if ("conversationKey" in input) {
                await context.env.storages.chatSessions.save(
                    projectId,
                    userId,
                    botId,
                    {
                        kind: "conversation",
                        id: access.conversationId,
                        title: input.title,
                    },
                    signal,
                );
            }
            context.env.logger.info(
                { event: "bot-chat-access-issued", userId, projectId, botId, conversationId: access.conversationId },
                "Chat audit event",
            );
            return privateJson(access);
        })
        .post("/bots/:botId/session-access", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context);
            const input = v.parse(v.strictObject({ sessionId: platformIdentifier }), await readJson(context, signal));
            const access = await gateway.nativeSessionAccess(projectId, input.sessionId, signal);
            context.env.logger.info(
                { event: "session-access-issued", userId, projectId, botId, sessionId: input.sessionId },
                "Chat audit event",
            );
            return privateJson(access);
        })
        .post("/bots/:botId/managed-session", authenticatedSession, async (context) => {
            const { projectId, botId, userId, signal } = await authorizeChat(context);
            const input = v.parse(v.strictObject({ sessionId: platformIdentifier }), await readJson(context, signal));
            return privateJson(
                await context.env.storages.chatSessions.readFork(projectId, userId, botId, input.sessionId, signal),
            );
        })
        .post("/bots/:botId/native-sessions", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context, 120000);
            const { runtimeId, ...input } = v.parse(nativeListInput, await readJson(context, signal));
            const result = await gateway.nativeSessions(projectId, runtimeId, input, signal);
            if (result.action !== "list") {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "The agent returned an invalid session directory.",
                    502,
                );
            }
            context.env.logger.info(
                { event: "native-session-listed", projectId, userId, botId, runtimeId },
                "Chat audit event",
            );
            return privateJson(result);
        })
        .post("/bots/:botId/native-session/:id", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context, 120000);
            const entryId = v.parse(platformIdentifier, context.req.param("id"));
            const { runtimeId, ...input } = v.parse(nativeEntryInput, await readJson(context, signal));
            const result = await gateway.nativeSessions(
                projectId,
                runtimeId,
                { ...input, entryId, action: "preview" },
                signal,
            );
            if (result.action !== "preview") {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "The agent returned an invalid session preview.",
                    502,
                );
            }
            context.env.logger.info(
                { event: "native-session-previewed", projectId, userId, botId, runtimeId, entryId },
                "Chat audit event",
            );
            return privateJson({ title: result.title, history: result.history });
        })
        .post("/bots/:botId/native-session/:id/fork", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context, 120000);
            const entryId = v.parse(platformIdentifier, context.req.param("id"));
            const { runtimeId, ...input } = v.parse(nativeEntryInput, await readJson(context, signal));
            const result = await gateway.nativeSessions(
                projectId,
                runtimeId,
                { ...input, entryId, action: "fork" },
                signal,
            );
            if (result.action !== "fork" || result.ready.sessionId !== result.targetSessionId) {
                throw new PlatformProjectError(
                    "FORK_UNAVAILABLE",
                    "This agent cannot fork the selected local session.",
                    409,
                );
            }
            await context.env.storages.chatSessions.save(
                projectId,
                userId,
                botId,
                {
                    kind: "fork",
                    id: result.ready.sessionId,
                    title: result.title || "Untitled session",
                    data: JSON.stringify({
                        agentRef: input.agentId,
                        result,
                        entry: {
                            entryId,
                            title: result.title,
                            directoryId: input.directoryId,
                            directoryLabel: input.directoryId,
                            additionalDirectories: result.ready.additionalDirectories,
                            updatedAt: null,
                        },
                    }),
                },
                signal,
            );
            context.env.logger.info(
                { event: "native-session-forked", userId, projectId, botId, runtimeId, entryId },
                "Chat audit event",
            );
            return privateJson(result);
        })
        .post("/bots/:botId/setup", authenticatedSession, async (context) => {
            const { projectId, botId, userId, gateway, signal } = await authorizeChat(context);
            const input = v.parse(setupInput, await readJson(context, signal));
            const result = await gateway.configureBot(projectId, botId, userId, input, signal);
            context.env.logger.info({ event: "bot-setup-requested", userId, projectId, botId }, "Bot audit event");
            return json(result, 202);
        });
}
