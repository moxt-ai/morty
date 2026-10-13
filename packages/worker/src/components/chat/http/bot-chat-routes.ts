import { encodeSessionStatusChangedEvent } from "@moxt-ai/mobius-protocol";
import { type Context, Hono } from "hono";
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

const setupInput = v.strictObject({
    runtimeId: platformIdentifier,
    agentRef: platformIdentifier,
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
const nativePreviewInput = v.strictObject({ ...nativeIdentity, nativeSessionId: platformIdentifier });
const directoryInput = v.strictObject({ directoryId: nativeDirectoryId });
const nativeContinuationInput = v.strictObject({
    action: v.picklist(["fork", "import"]),
    harness: platformIdentifier,
    sessionId: platformIdentifier,
});
const nativeSessionInput = v.strictObject({ sessionId: platformIdentifier });
const sessionConfiguration = v.strictObject({
    booleanValue: v.boolean(),
    configId: platformIdentifier,
    value: v.pipe(v.string(), v.maxLength(500)),
    valueType: v.picklist(["select", "boolean"]),
});
const sessionConfigurations = v.pipe(
    v.array(sessionConfiguration),
    v.maxLength(100),
    v.check(
        (selections) => new Set(selections.map((selection) => selection.configId)).size === selections.length,
        "Session configuration identifiers must be unique.",
    ),
);
const agentSettingsInput = v.strictObject({ agentRef: platformIdentifier });
const accessInput = v.union([
    v.strictObject({ conversationId: platformIdentifier }),
    v.strictObject({
        agentRef: platformIdentifier,
        conversationKey: platformIdentifier,
        configurations: sessionConfigurations,
        title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)), "New chat"),
        workspaceRef: nativeDirectoryId,
    }),
    v.strictObject({
        agentRef: platformIdentifier,
        conversationKey: platformIdentifier,
        permissionMode: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
        title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)), "New chat"),
        configuration: v.strictObject({
            additionalDirectoryIds: v.pipe(v.array(nativeDirectoryId), v.maxLength(16)),
            booleanValue: v.boolean(),
            configId: platformIdentifier,
            value: v.pipe(v.string(), v.maxLength(500)),
            valueType: v.picklist(["select", "boolean"]),
        }),
        workspaceRef: nativeDirectoryId,
    }),
]);

type AuthorizedChatEnvironment = ChatHttpEnvironment & {
    readonly Variables: ChatHttpEnvironment["Variables"] & {
        readonly session: Session;
        readonly chatScope: ChatScope;
    };
};

async function authorizeChat(context: Context<AuthorizedChatEnvironment>, timeout = 45000) {
    const { userId } = context.get("session");
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)]);
    const projectId = v.parse(platformIdentifier, context.req.param("projectId"));
    const botId = v.parse(platformIdentifier, context.req.param("botId"));
    return await context.env.services.chat.authorize(userId, projectId, botId, signal, context.get("operationTiming"));
}

function authorizedChat(timeout = 45000) {
    return createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
        context.set("chatScope", await authorizeChat(context, timeout));
        await next();
    });
}

function privateJson(value: unknown) {
    const response = json(value);
    response.headers.set("Cache-Control", "no-store");
    return response;
}

function sessionStatusStream(context: Context<AuthorizedChatEnvironment>): Response {
    const lifetime = new AbortController();
    const abort = (): void => lifetime.abort(context.req.raw.signal.reason);
    context.req.raw.signal.addEventListener("abort", abort, { once: true });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
            void context.env.services.chat
                .subscribeManagedSessionStatuses(
                    context.get("chatScope"),
                    (event) => controller.enqueue(encoder.encode(`${encodeSessionStatusChangedEvent(event)}\n`)),
                    lifetime.signal,
                )
                .then(
                    () => controller.close(),
                    (cause: unknown) => {
                        if (lifetime.signal.aborted) {
                            controller.close();
                        } else {
                            controller.error(cause);
                        }
                    },
                )
                .finally(() => context.req.raw.signal.removeEventListener("abort", abort));
        },
        cancel: (reason) => lifetime.abort(reason),
    });
    return new Response(body, {
        headers: { "Cache-Control": "no-store", "Content-Type": "application/x-ndjson" },
    });
}

export function createBotChatRoutes() {
    return new Hono<AuthorizedChatEnvironment>()
        .use(
            "*",
            bodyLimit({
                maxSize: 6500000,
                onError: () => {
                    throw new PlatformProjectError("INVALID_REQUEST", "The message is too large.", 413);
                },
            }),
        )
        .post("/bots/:botId/workspace", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.runtimeConfiguration(context.get("chatScope")));
        })
        .post("/bots/:botId/daemon-diagnostics", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.daemonDiagnostics(context.get("chatScope")));
        })
        .post("/bots/:botId/network-diagnostic", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.networkDiagnostic(context.get("chatScope")));
        })
        .post("/bots/:botId/setup/runtimes", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.setupRuntimes(context.get("chatScope")));
        })
        .post(
            "/bots/:botId/workspace/directory",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof directoryInput>(directoryInput),
            async (context) =>
                privateJson(
                    await context.env.services.chat.listDirectory(
                        context.get("chatScope"),
                        context.req.valid("json").directoryId,
                    ),
                ),
        )
        .post("/bots/:botId/managed-sessions", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.managedSessions(context.get("chatScope")));
        })
        .post("/bots/:botId/managed-session/status-events", authenticatedSession, authorizedChat(), sessionStatusStream)
        .post(
            "/bots/:botId/agent-settings",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof agentSettingsInput>(agentSettingsInput),
            async (context) =>
                privateJson(
                    await context.env.services.chat.agentSettings(
                        context.get("chatScope"),
                        context.req.valid("json").agentRef,
                    ),
                ),
        )
        .post(
            "/bots/:botId/access",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof accessInput>(accessInput),
            async (context) => {
                return privateJson(
                    await context.env.services.chat.openChat(
                        context.get("chatScope"),
                        context.req.valid("json"),
                        context.get("operationTiming"),
                    ),
                );
            },
        )
        .post(
            "/bots/:botId/session-access",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionInput>(nativeSessionInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.nativeSessionAccess(context.get("chatScope"), input.sessionId),
                );
            },
        )
        .post(
            "/bots/:botId/managed-session",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionInput>(nativeSessionInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.managedSession(context.get("chatScope"), input.sessionId),
                );
            },
        )
        .post(
            "/bots/:botId/managed-session/archive",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionInput>(nativeSessionInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.archiveManagedSession(context.get("chatScope"), input.sessionId),
                );
            },
        )
        .post(
            "/bots/:botId/native-sessions",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeListInput>(nativeListInput),
            async (context) => {
                const { runtimeId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.nativeSessions(context.get("chatScope"), runtimeId, input),
                );
            },
        )
        .post(
            "/bots/:botId/continue-native-session",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeContinuationInput>(nativeContinuationInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.continueNativeSession(
                        context.get("chatScope"),
                        input.harness,
                        input.sessionId,
                        input.action,
                    ),
                );
            },
        )
        .post(
            "/bots/:botId/native-session/:id",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativePreviewInput>(nativePreviewInput),
            async (context) => {
                const entryId = v.parse(platformIdentifier, context.req.param("id"));
                const { runtimeId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.previewNativeSession(
                        context.get("chatScope"),
                        runtimeId,
                        entryId,
                        input,
                    ),
                );
            },
        )
        .post(
            "/bots/:botId/native-session/:id/import",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const entryId = v.parse(platformIdentifier, context.req.param("id"));
                const { runtimeId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.importNativeSession(
                        context.get("chatScope"),
                        runtimeId,
                        entryId,
                        input,
                    ),
                );
            },
        )
        .post(
            "/bots/:botId/native-session/:id/fork",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const entryId = v.parse(platformIdentifier, context.req.param("id"));
                const { runtimeId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.forkNativeSession(
                        context.get("chatScope"),
                        runtimeId,
                        entryId,
                        input,
                    ),
                );
            },
        )
        .post(
            "/bots/:botId/setup",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof setupInput>(setupInput),
            async (context) => {
                const input = context.req.valid("json");
                return json(await context.env.services.chat.configureBot(context.get("chatScope"), input), 202);
            },
        );
}
