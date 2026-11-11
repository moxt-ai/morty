import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    type Identifier,
    isIdentifier,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    type TurnState,
} from "@morty-build/client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import type { RelayHttpEnvironment } from "../../../composition/relay-http-environment.ts";
import { createBrowserCors } from "../../../middleware/browser-cors.ts";
import { PairingDirectoryError, validateIdentifier } from "../../management/entity/pairing.ts";
import { createRelayProtocolRoutes } from "../../management/http/protocol-routes.ts";
import { ComputerScope } from "../entity/session.ts";
import type { SessionAccess } from "../service/session-access-service.ts";
import { SessionControl, type TurnAdmission } from "../service/session-control.ts";
import { initializeSessionAccessTargetMiddleware, sessionAccessTargetMiddleware } from "./session-access-target.ts";
import { authorizeSessionContentUpload } from "./session-content-upload.ts";
import {
    decodeSessionRequest,
    interactionResponseRequest,
    sessionConfigurationRequest,
    sessionRenameRequest,
    turnSteerRequest,
    turnSubmissionRequest,
} from "./session-requests.ts";

export type { RelayHttpEnvironment } from "../../../composition/relay-http-environment.ts";

// A request a Session credential authorizes is routed to its ComputerRelay before any Session route runs.
function sessionOperations(context: { readonly var: RelayHttpEnvironment["Variables"] }) {
    if (context.var.sessionExecution.kind !== "local") {
        throw new Error("Session operations run only in the ComputerRelay");
    }
    return context.var.sessionExecution.operations;
}

function nativeTarget(request: { readonly param: (name: string) => string | undefined }): NativeSessionTarget {
    return {
        harness: validateIdentifier(request.param("harness") ?? "", "harness"),
        sessionId: validateIdentifier(request.param("sessionId") ?? "", "session_id"),
    };
}

/** Session operations through a Session credential, each authorized for its own permission on that Session. */
function authorizedSessionControl(
    context: {
        readonly var: RelayHttpEnvironment["Variables"];
        readonly req: { readonly raw: Request };
    },
    access: SessionAccess,
    sessionTarget: NativeSessionTarget,
): SessionControl {
    const scope = new ComputerScope(access.computerId);
    return new SessionControl(async (command, permission) => {
        await access.authorize(permission, context.req.raw.signal);
        return await sessionOperations(context).requestComputerScopeControl(
            scope,

            command,
            context.req.raw.signal,
        );
    }, sessionTarget);
}

/**
 * The Turn state a submission reply states, as of `answeredAt`. A retried command that already settled is answered
 * without how or when it ended, so its Turn is indeterminate rather than running: the command's own lifecycle events,
 * or the Session execution naming it, carry its outcome.
 */
function submittedTurnState(state: TurnAdmission["state"], answeredAt: string): TurnState {
    switch (state) {
        case "queued":
            return { kind: "queued" };
        case "running":
            return { kind: "running", startedAt: answeredAt };
        case "settled":
            return {
                kind: "indeterminate",
                reconciliation: { detectedAt: answeredAt, reason: "dispatch_indeterminate" },
            };
    }
}

const sessionIdentifier = v.custom<Identifier>(isIdentifier);

/** Unmatched protocol routes keep their stable machine-readable error when mounted into the host. */
function notFoundResponse(): Response {
    return Response.json(
        { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
        { status: 404 },
    );
}

export function createRelayRoutes() {
    const sessionRoutes = new Hono<RelayHttpEnvironment>()
        .use(
            "*",
            createBrowserCors(
                ["GET", "POST", "PUT"],
                ["authorization", "content-type", "x-morty-byte-length", "x-morty-content-kind", "x-morty-file-name"],
            ),
        )
        .get("/:sessionId/live-event-subscription-target", sessionAccessTargetMiddleware, async (context) => {
            const authorization = context.req.header("authorization") ?? "";
            const credential = authorization.match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    {
                        error: {
                            code: "session_access_required",
                            message: "A live Session credential is required",
                        },
                    },
                    401,
                );
            }
            const target = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({
                expiresAtEpochMilliseconds: target.expiresAtEpochMilliseconds,
                issuedAtEpochMilliseconds: target.issuedAtEpochMilliseconds,
                kind: "expiring",
                computerId: target.computerId,
            });
        })
        .get("/:sessionId/configuration", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const control = authorizedSessionControl(context, access, sessionTarget);
            const result = await control.readConfiguration();
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .get("/:sessionId/active-turn", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const commandId = context.req.query("commandId");
            const control = authorizedSessionControl(context, access, sessionTarget);
            const result = await control.activeTurn(
                commandId === undefined ? undefined : decodeSessionRequest(sessionIdentifier, commandId),
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/turns", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const body = decodeSessionRequest(turnSubmissionRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionTarget);
            const accepted = await control.submitTurn({ ...body, commandId: body.idempotencyKey });
            const acceptedAt = new Date().toISOString();
            context.header("Cache-Control", "no-store");
            return context.json({
                acceptedAt,
                idempotencyKey: body.idempotencyKey,
                request: {
                    content: body.content,
                    kind: "prompt",
                    sessionConfigurations: body.sessionConfigurations,
                },
                target: sessionTarget,
                state: submittedTurnState(accepted.state, acceptedAt),
                turnId: accepted.commandId,
            });
        })
        .put("/:sessionId/turns/:turnId/disposition", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const turnId = decodeSessionRequest(sessionIdentifier, context.req.param("turnId"));
            decodeSessionRequest(turnSteerRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionTarget);
            await control.steerTurn(turnId);
            context.header("Cache-Control", "no-store");
            return context.json({ turnId });
        })
        .get("/:sessionId/files/content", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const path = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
                context.req.query("path"),
            );
            const maxBytes = decodeSessionRequest(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(128 * 1024 * 1024)),
                Number(context.req.query("maxBytes") ?? String(32 * 1024 * 1024)),
            );
            return await sessionOperations(context).readProjectSessionFile(
                new ComputerScope(access.computerId),
                decodeFileReadCommand(
                    JSON.stringify({
                        kind: "file.read",
                        maxBytes,
                        path,
                        requestId: crypto.randomUUID(),
                        target: sessionTarget,
                    }),
                ),
                context.req.raw.signal,
            );
        })
        .put("/:sessionId/content/:contentKey", async (context) => {
            const authorized = await authorizeSessionContentUpload(context.req.raw, context.var.sessionAccess);
            if (authorized instanceof Response) {
                return authorized;
            }
            const { access, target, contentKey } = authorized;
            const byteLength = decodeSessionRequest(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(CONTENT_WRITE_MAX_BYTES)),
                Number(context.req.header("x-morty-byte-length") ?? ""),
            );
            const contentKind = decodeSessionRequest(
                v.picklist(["image", "resource"]),
                context.req.header("x-morty-content-kind"),
            );
            const mediaType = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
                context.req.header("content-type"),
            );
            const encodedName = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(1_500)),
                context.req.header("x-morty-file-name"),
            );
            const uri = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
                context.req.query("uri"),
            );
            const body = context.req.raw.body;
            if (body === null) {
                throw new PairingDirectoryError("invalid_request", "The content body is required");
            }
            let name: string;
            try {
                name = decodeURIComponent(encodedName);
            } catch (cause) {
                throw new PairingDirectoryError("invalid_request", "The content name is invalid", { cause });
            }
            name = decodeSessionRequest(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), name);
            const available = await sessionOperations(context).writeProjectSessionContent(
                new ComputerScope(access.computerId),
                decodeContentWriteCommand(
                    JSON.stringify({
                        byteLength,
                        contentKey,
                        contentKind,
                        kind: "content.write",
                        mediaType,
                        name,
                        requestId: crypto.randomUUID(),
                        target,
                    }),
                ),
                body,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({
                byteLength,
                contentKey: available.contentKey,
                kind: contentKind,
                mimeType: mediaType,
                name,
                uri,
            });
        })
        .post("/:sessionId/configuration", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const body = decodeSessionRequest(sessionConfigurationRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionTarget);
            const result = await control.configure(body);
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/rename", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const body = decodeSessionRequest(sessionRenameRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionTarget);
            const result = await control.rename(body.title);
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/:sessionId/turns/:turnId/cancel-before-start", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const turnId = decodeSessionRequest(sessionIdentifier, context.req.param("turnId"));
            const control = authorizedSessionControl(context, access, sessionTarget);
            await control.withdrawTurn(turnId);
            context.header("Cache-Control", "no-store");
            return context.json({ turnId });
        })
        .post("/:sessionId/turns/:turnId/cancel", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const turnId = decodeSessionRequest(sessionIdentifier, context.req.param("turnId"));
            const control = authorizedSessionControl(context, access, sessionTarget);
            const { stopReason } = await control.cancelTurn(turnId);
            context.header("Cache-Control", "no-store");
            return context.json({ turnId, stopReason });
        })
        .post("/:sessionId/interactions/:interactionId/responses", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authenticate(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const sessionTarget = nativeTarget(context.req);
            const interactionId = decodeSessionRequest(sessionIdentifier, context.req.param("interactionId"));
            const body = decodeSessionRequest(interactionResponseRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionTarget);
            await control.respond(interactionId, body);
            context.header("Cache-Control", "no-store");
            return context.json({ accepted: true });
        })
        .get("/:sessionId/events-v2", sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const target = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
                const events = await authorizedSessionControl(context, target, nativeTarget(context.req)).liveEvents({
                    cursor: decodeSessionRequest(
                        v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
                        context.req.query("cursor") ?? null,
                    ),
                    eventLimit: decodeSessionRequest(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                        Number(context.req.query("limit") ?? "50"),
                    ),
                });
                context.header("Cache-Control", "no-store");
                return context.json(events);
            }
            return await sessionOperations(context).openPublicSessionEvents(
                new ComputerScope(target.computerId),

                nativeTarget(context.req),
                {
                    signingKeyId: target.signingKeyId,
                    grant: target.grant,
                    expiresAt: target.expiresAtEpochMilliseconds,
                },
                context.req.raw.signal,
            );
        });
    return new Hono<RelayHttpEnvironment>()
        .use(`${MORTY_API_PREFIX}/v1/*`, initializeSessionAccessTargetMiddleware)
        .use(`${MORTY_API_PREFIX}/channels/*`, initializeSessionAccessTargetMiddleware)
        .route(`${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions`, sessionRoutes)
        .route("/", createRelayProtocolRoutes())
        .all(`${MORTY_API_PREFIX}/v1/*`, notFoundResponse)
        .all(`${MORTY_API_PREFIX}/channels/*`, notFoundResponse);
}
