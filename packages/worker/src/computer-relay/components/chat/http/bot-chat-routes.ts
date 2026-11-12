import { isDirectoryPath, type SessionAccessHolder } from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import type { Session } from "../../../../contracts/authentication/session.ts";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { authenticatedSession, credentialRejected, localSession } from "../../management/http/authenticated-session.ts";
import { type ChatScope, MINIMUM_SESSION_CREDENTIAL_SECONDS } from "../service/chat-service.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

const setupInput = v.strictObject({
    computerId: relayIdentifier,
    harness: relayIdentifier,
});
const nativeDirectory = v.custom<string>(isDirectoryPath);
const nativeIdentity = {
    computerId: relayIdentifier,
    harness: relayIdentifier,
    directory: nativeDirectory,
};
const nativeListInput = v.strictObject({
    ...nativeIdentity,
    action: v.literal("list"),
    cursor: v.nullable(relayIdentifier),
});
const nativeEntryInput = v.strictObject({ ...nativeIdentity });
const nativePreviewInput = v.strictObject({ ...nativeIdentity, sessionId: relayIdentifier });
const directoryInput = v.strictObject({ directory: nativeDirectory });
const nativeContinuationInput = v.strictObject({ harness: relayIdentifier, sessionId: relayIdentifier });
const sessionConfiguration = v.strictObject({
    booleanValue: v.boolean(),
    configId: relayIdentifier,
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
const agentSettingsInput = v.strictObject({
    harness: relayIdentifier,
    workspaceRef: nativeDirectory,
});
const nativeSessionTargetInput = v.strictObject({ harness: relayIdentifier, sessionId: relayIdentifier });
const accessInput = v.union([
    nativeSessionTargetInput,
    v.strictObject({
        harness: relayIdentifier,
        conversationKey: relayIdentifier,
        configurations: sessionConfigurations,
        workspaceRef: nativeDirectory,
    }),
]);

type AuthorizedChatEnvironment = ChatHttpEnvironment & {
    readonly Variables: ChatHttpEnvironment["Variables"] & {
        readonly session: Session;
        readonly accessExpiresAt: number | null;
        readonly accessHolder: SessionAccessHolder;
        readonly chatScope: ChatScope;
    };
};

async function authorizeChat(context: Context<AuthorizedChatEnvironment>, signal: AbortSignal) {
    const computerId = v.parse(relayIdentifier, context.req.param("computerId"));
    const requester = {
        computerId: context.get("session").computerId,
        accessExpiresAt: context.get("accessExpiresAt"),
        holder: context.get("accessHolder"),
    };
    return await context.var.application.services.chat.authorize(requester, computerId, signal);
}

/**
 * Guards issuing a Session credential, which lives on at the Relay after this response. Access ending sooner than
 * the shortest Session credential is refused rather than outlived, and access that ended while the credential was
 * issued does not receive it.
 */
const issuesSessionCredential = createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
    const accessExpiresAt = context.get("accessExpiresAt");
    if (accessExpiresAt !== null && accessExpiresAt - Date.now() < MINIMUM_SESSION_CREDENTIAL_SECONDS * 1000) {
        throw credentialRejected("revoked");
    }
    await next();
    const current = await context.var.application.services.authentication.session(
        context.get("bearerToken"),
        context.req.raw.signal,
    );
    if (current.kind !== "authenticated") {
        throw credentialRejected(current.kind);
    }
});

function authorizedChat(timeout = 45000) {
    return createMiddleware<AuthorizedChatEnvironment>(async (context, next) => {
        using deadline = new RequestDeadline(context.req.raw.signal, timeout);
        context.set("chatScope", await authorizeChat(context, deadline.signal));
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
        .post("/workspace", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(
                await context.var.application.services.chat.computerConfiguration(context.get("chatScope")),
            );
        })
        .post("/daemon-diagnostics", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.var.application.services.chat.daemonDiagnostics(context.get("chatScope")));
        })
        .post("/network-diagnostic", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.var.application.services.chat.networkDiagnostic(context.get("chatScope")));
        })
        .post("/setup/computers", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.var.application.services.chat.setupComputers(context.get("chatScope")));
        })
        .post(
            "/workspace/directory",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof directoryInput>(directoryInput),
            async (context) =>
                privateJson(
                    await context.var.application.services.chat.listDirectory(
                        context.get("chatScope"),
                        context.req.valid("json").directory,
                    ),
                ),
        )
        .post("/managed-sessions", authenticatedSession, authorizedChat(), async (context) => {
            return privateJson(await context.var.application.services.chat.managedSessions(context.get("chatScope")));
        })
        .post(
            "/agent-settings",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof agentSettingsInput>(agentSettingsInput),
            async (context) =>
                privateJson(
                    await context.var.application.services.chat.agentSettings(
                        context.get("chatScope"),
                        context.req.valid("json"),
                    ),
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
                    await context.var.application.services.chat.openChat(
                        context.get("chatScope"),
                        context.req.valid("json"),
                    ),
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
                    await context.var.application.services.chat.nativeSessionAccess(context.get("chatScope"), input),
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
                return privateJson(
                    await context.var.application.services.chat.managedSession(context.get("chatScope"), input),
                );
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
                    await context.var.application.services.chat.archiveManagedSession(context.get("chatScope"), input),
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
                    await context.var.application.services.chat.nativeSessions(
                        context.get("chatScope"),
                        computerId,
                        input,
                    ),
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
                    await context.var.application.services.chat.continueNativeSession(
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
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const sessionId = v.parse(relayIdentifier, context.req.param("id"));
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.var.application.services.chat.previewNativeSession(
                        context.get("chatScope"),
                        computerId,
                        {
                            ...input,
                            sessionId,
                        },
                    ),
                );
            },
        )
        .post(
            "/native-session/:id/import",
            authenticatedSession,
            authorizedChat(120000),
            bodyParser<AuthorizedChatEnvironment, typeof nativeEntryInput>(nativeEntryInput),
            async (context) => {
                const sessionId = v.parse(relayIdentifier, context.req.param("id"));
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.var.application.services.chat.importNativeSession(
                        context.get("chatScope"),
                        computerId,
                        sessionId,
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
                const operationId = v.parse(relayIdentifier, context.req.param("operationId"));
                const { computerId, ...input } = context.req.valid("json");
                return privateJson(
                    await context.var.application.services.chat.recoverableNativeFork(
                        context.get("chatScope"),
                        computerId,
                        operationId,
                        input,
                    ),
                );
            },
        )
        .post(
            "/setup",
            localSession("verifyAgent"),
            authorizedChat(),
            bodyParser<AuthorizedChatEnvironment, typeof setupInput>(setupInput),
            async (context) => {
                const input = context.req.valid("json");
                return json(
                    await context.var.application.services.chat.verifyAgent(context.get("chatScope"), input),
                    202,
                );
            },
        );
}
