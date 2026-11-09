import {
    encodeSessionCloseNoticeEvent,
    encodeSessionStatusChangedEvent,
    isDirectoryIdentifier,
} from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import type { Session } from "../../management/entity/authentication/session.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";
import { authenticatedSession, credentialRejected, localSession } from "../../management/http/authenticated-session.ts";
import {
    type ChatScope,
    MANAGED_SESSION_STATUSES_FOLLOWING_KIND,
    type ManagedSessionEvent,
    MINIMUM_SESSION_CREDENTIAL_SECONDS,
} from "../service/chat-service.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

const setupInput = v.strictObject({
    computerId: platformIdentifier,
    agentRef: platformIdentifier,
});
const nativeDirectoryId = v.custom<string>(isDirectoryIdentifier);
const nativeIdentity = {
    computerId: platformIdentifier,
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
const nativePreviewInput = v.strictObject({ ...nativeIdentity, sessionId: platformIdentifier });
const directoryInput = v.strictObject({ directoryId: nativeDirectoryId });
const nativeContinuationInput = v.strictObject({ harness: platformIdentifier, sessionId: platformIdentifier });
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
// A page loaded before drafts named their directory omits `workspaceRef`; its settings are the default directory's.
const agentSettingsInput = v.strictObject({
    agentRef: platformIdentifier,
    workspaceRef: v.optional(nativeDirectoryId),
});
const nativeSessionTargetInput = v.strictObject({ harness: platformIdentifier, sessionId: platformIdentifier });
const accessInput = v.union([
    nativeSessionTargetInput,
    v.strictObject({
        agentRef: platformIdentifier,
        conversationKey: platformIdentifier,
        configurations: sessionConfigurations,
        workspaceRef: nativeDirectoryId,
    }),
]);

type AuthorizedChatEnvironment = ChatHttpEnvironment & {
    readonly Variables: ChatHttpEnvironment["Variables"] & {
        readonly session: Session;
        readonly accessExpiresAt: number | null;
        readonly chatScope: ChatScope;
    };
};

async function authorizeChat(context: Context<AuthorizedChatEnvironment>, timeout = 45000) {
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)]);
    const computerId = v.parse(platformIdentifier, context.req.param("computerId"));
    const requester = { userId: context.get("session").userId, accessExpiresAt: context.get("accessExpiresAt") };
    return await context.env.services.chat.authorize(requester, computerId, signal);
}

/**
 * Guards issuing a Session credential, which lives on at the Platform after this response. Access ending sooner than
 * the shortest Session credential is refused rather than outlived, and access that ended while the credential was
 * issued does not receive it.
 */
const issuesSessionCredential = createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
    const accessExpiresAt = context.get("accessExpiresAt");
    if (accessExpiresAt !== null && accessExpiresAt - Date.now() < MINIMUM_SESSION_CREDENTIAL_SECONDS * 1000) {
        throw credentialRejected("revoked");
    }
    await next();
    const current = await context.env.services.authentication.session(
        context.get("bearerToken"),
        context.req.raw.signal,
    );
    if (current.kind !== "authenticated") {
        throw credentialRejected(current.kind);
    }
});

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

function encodeManagedSessionEvent(event: ManagedSessionEvent): string {
    switch (event.kind) {
        case MANAGED_SESSION_STATUSES_FOLLOWING_KIND:
            return JSON.stringify({ kind: event.kind, sessions: event.sessions, statuses: event.statuses });
        case "session.status.changed":
            return encodeSessionStatusChangedEvent(event);
        case "session.close.notice":
            return encodeSessionCloseNoticeEvent(event);
    }
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
                    async (event) => {
                        // The stream outlives the authorization that opened it, so each event is sent only while that
                        // access still holds; ending access ends the stream, and the reopened stream is refused.
                        const access = await context.env.services.authentication.session(
                            context.get("bearerToken"),
                            lifetime.signal,
                        );
                        if (access.kind !== "authenticated") {
                            lifetime.abort(credentialRejected(access.kind));
                            return;
                        }
                        controller.enqueue(encoder.encode(`${encodeManagedSessionEvent(event)}\n`));
                    },
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
        .post("/workspace", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.runtimeConfiguration(context.get("chatScope")));
        })
        .post("/daemon-diagnostics", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.daemonDiagnostics(context.get("chatScope")));
        })
        .post("/network-diagnostic", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.networkDiagnostic(context.get("chatScope")));
        })
        .post("/setup/runtimes", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.setupRuntimes(context.get("chatScope")));
        })
        .post(
            "/workspace/directory",
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
        .post("/managed-sessions", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.env.services.chat.managedSessions(context.get("chatScope")));
        })
        .post("/managed-session/status-events", authenticatedSession, authorizedChat(), sessionStatusStream)
        .post(
            "/agent-settings",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof agentSettingsInput>(agentSettingsInput),
            async (context) =>
                privateJson(
                    await context.env.services.chat.agentSettings(context.get("chatScope"), {
                        agentRef: context.req.valid("json").agentRef,
                        workspaceRef: context.req.valid("json").workspaceRef ?? "default",
                    }),
                ),
        )
        .post(
            "/access",
            authenticatedSession,
            issuesSessionCredential,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof accessInput>(accessInput),
            async (context) => {
                return privateJson(
                    await context.env.services.chat.openChat(context.get("chatScope"), context.req.valid("json")),
                );
            },
        )
        .post(
            "/session-access",
            authenticatedSession,
            issuesSessionCredential,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.nativeSessionAccess(context.get("chatScope"), input),
                );
            },
        )
        .post(
            "/managed-session",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(await context.env.services.chat.managedSession(context.get("chatScope"), input));
            },
        )
        .post(
            "/managed-session/archive",
            authenticatedSession,
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof nativeSessionTargetInput>(nativeSessionTargetInput),
            async (context) => {
                const input = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.archiveManagedSession(context.get("chatScope"), input),
                );
            },
        )
        .post(
            "/native-sessions",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeListInput>(nativeListInput),
            async (context) => {
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.nativeSessions(context.get("chatScope"), computerId, input),
                );
            },
        )
        .post(
            "/continue-native-session",
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
                    ),
                );
            },
        )
        .post(
            "/native-session/:id",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativePreviewInput>(nativePreviewInput),
            async (context) => {
                // The preview is addressed by the request body; validate the path identifier for the route contract.
                v.parse(platformIdentifier, context.req.param("id"));
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.previewNativeSession(context.get("chatScope"), computerId, input),
                );
            },
        )
        .post(
            "/native-session/:id/import",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const entryId = v.parse(platformIdentifier, context.req.param("id"));
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.env.services.chat.importNativeSession(
                        context.get("chatScope"),
                        computerId,
                        entryId,
                        input,
                    ),
                );
            },
        )
        .post(
            "/native-session-forks/:operationId",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativePreviewInput>(nativePreviewInput),
            async (context) => {
                const operationId = v.parse(platformIdentifier, context.req.param("operationId"));
                const { computerId, ...input } = context.req.valid("json");
                const receipt = await context.env.services.chat.recoverableNativeFork(
                    context.get("chatScope"),
                    computerId,
                    operationId,
                    input,
                );
                return privateJson(receipt.result);
            },
        )
        .post(
            "/setup",
            localSession("configureBot"),
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof setupInput>(setupInput),
            async (context) => {
                const input = context.req.valid("json");
                return json(await context.env.services.chat.configureBot(context.get("chatScope"), input), 202);
            },
        );
}
