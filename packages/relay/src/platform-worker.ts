import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    type Identifier,
    isDirectoryIdentifier,
    isIdentifier,
    MORTY_API_PREFIX,
    type TurnState,
} from "@morty-build/client/protocol";
import type { LocalSessionOperations, ProjectStore } from "@morty-build/relay-core";
import {
    AccountScope,
    CloudflareChannelRuntime,
    createMortyApplication,
    createWorkerContext,
    decodeSessionRequest,
    errorMiddleware,
    instrumentD1Database,
    interactionResponseRequest,
    PairingDirectoryError,
    type RelayContext,
    RequestAccessMetrics,
    requestTimeoutMiddleware,
    type SessionBindingRequest,
    SessionControl,
    sessionConfigurationRequest,
    sessionRenameRequest,
    type TurnAdmission,
    turnSteerRequest,
    turnSubmissionRequest,
    validateIdentifier,
    type WorkerRuntimeGateways,
} from "@morty-build/relay-core";
import { type Context, type Handler, Hono } from "hono";
import * as v from "valibot";
import {
    type PlatformAuthenticationEnvironment,
    platformAuthenticationFromEnvironment,
} from "./composition/platform-authentication-environment.ts";
import { RuntimeRelay } from "./durable-objects/runtime-relay.ts";
import type { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
import { SessionAccessSigner } from "./entity/session-access-credential.ts";
import {
    type AccountDurableObjectExecutionBindings,
    type AccountWorkerRoutingBindings,
    routeAccountDurableObject,
} from "./gateway/account-durable-object-routing.ts";
import { AccountDurableObjectStores } from "./gateway/account-durable-object-store.ts";
import { routeRuntimeSessionRequest } from "./gateway/runtime-session-routing.ts";
import { createPlatformControlApplication } from "./http/platform-routes.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import { authorizeSessionContentUpload } from "./http/session-content-upload.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { createBrowserCors } from "./middleware/browser-cors.ts";
import {
    initializeSessionAccessTargetMiddleware,
    sessionAccessTargetMiddleware,
} from "./middleware/session-access-target.ts";
import { AppCredentialAuthenticationService } from "./service/app-credential-authentication-service.ts";
import { PlatformControlPlaneService } from "./service/platform-control-plane-service.ts";
import {
    type SessionAccess,
    SessionAccessService,
    type SessionAccessTarget,
} from "./service/session-access-service.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import { type PlatformStorageBindings, PlatformStorageRegistry } from "./storage/platform-storage-registry.ts";

export interface PlatformRelayBindings extends PlatformStorageBindings, AccountWorkerRoutingBindings {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly RUNTIME_RELAY: DurableObjectNamespace<RuntimeRelay>;
    /** Worker secret from which the Relay derives the keys that sign Session credentials. */
    readonly MORTY_SESSION_SIGNING_SECRET: string;
}

export interface AccountPlatformRelayBindings extends PlatformRelayBindings, AccountDurableObjectExecutionBindings {}

export interface RuntimeExecutionBindings extends PlatformRelayBindings {
    readonly MORTY_RUNTIME_EXECUTION: {
        readonly accountId: string;
        readonly runtimeId: string;
        readonly operations: LocalSessionOperations;
    };
}
type PlatformApplicationBindings = PlatformRelayBindings | AccountPlatformRelayBindings | RuntimeExecutionBindings;

export interface ConfiguredPlatformRelayBindings extends PlatformRelayBindings, PlatformAuthenticationEnvironment {}

// A request a Session credential authorizes is routed to its Runtime's RuntimeRelay before any Session route runs.
function sessionOperations(context: { readonly env: PlatformApplicationBindings }) {
    if (!("MORTY_RUNTIME_EXECUTION" in context.env)) {
        throw new Error("Session operations run only in the Runtime's RuntimeRelay");
    }
    return context.env.MORTY_RUNTIME_EXECUTION.operations;
}

/** Session operations on the Runtime a Session credential authorized. */
/** Session operations through a Session credential, each authorized for its own permission on that Session. */
function authorizedSessionControl(
    context: {
        readonly env: PlatformApplicationBindings;
        readonly var: { readonly relay: RelayContext };
        readonly req: { readonly raw: Request };
    },
    access: SessionAccess,
    sessionId: string,
): SessionControl {
    const scope = new AccountScope(access.accountId);
    return new SessionControl(async (command, permission) => {
        await access.authorize(permission, context.req.raw.signal);
        return await sessionOperations(context).requestAccountScopeControl(
            scope,
            access.runtimeId,
            command,
            context.req.raw.signal,
        );
    }, sessionId);
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

const projectApplication = createMortyApplication();
const scopedProjectApplication = createProjectApplication();
const controlApplication = createPlatformControlApplication();
const PLATFORM_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const sessionIdentifier = v.custom<Identifier>(isIdentifier);
/**
 * A Session binding stated in a query string. Each omitted field is the Session's own. A query cannot tell an empty
 * list from an omitted one; callers that state the binding send no `additionalDirectoryId` for an empty list, so with
 * `agentId` or `directoryId` present an absent list is empty.
 */
function sessionBindingQuery(request: {
    readonly query: (name: string) => string | undefined;
    readonly queries: (name: string) => string[] | undefined;
}): SessionBindingRequest {
    const agentId = request.query("agentId");
    const directoryId = request.query("directoryId");
    const additionalDirectoryIds = request.queries("additionalDirectoryId");
    return {
        additionalDirectoryIds:
            additionalDirectoryIds === undefined && agentId === undefined && directoryId === undefined
                ? undefined
                : v.parse(
                      v.pipe(v.array(v.custom<string>(isDirectoryIdentifier)), v.maxLength(16)),
                      additionalDirectoryIds ?? [],
                  ),
        agentId: agentId === undefined ? undefined : v.parse(sessionIdentifier, agentId),
        directoryId:
            directoryId === undefined ? undefined : v.parse(v.custom<string>(isDirectoryIdentifier), directoryId),
    };
}

type DispatchEnvironment = {
    readonly Bindings: PlatformApplicationBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
        readonly stores: AccountDurableObjectStores;
        readonly projects: PlatformProjectStorageDirectory;
        readonly identityStores: readonly ProjectStore[];
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
};

function optionalExecutionContext(context: Pick<Context, "executionCtx">): Context["executionCtx"] | undefined {
    try {
        return context.executionCtx;
    } catch {
        return undefined;
    }
}

export function createPlatformAccessServices(environment: PlatformApplicationBindings) {
    const execution =
        "MORTY_ACCOUNT_STORE" in environment
            ? { accountId: environment.MORTY_ACCOUNT_ID, store: environment.MORTY_ACCOUNT_STORE }
            : null;
    const stores = new AccountDurableObjectStores(environment.ACCOUNT_RELAY, execution);
    const identityStores = execution === null ? [] : [execution.store];
    const controlStorage = new PlatformControlPlaneStorage(environment.PLATFORM_DIRECTORY_DATABASE, stores);
    const storageRegistry = new PlatformStorageRegistry(environment);
    const appAuthentication = new AppCredentialAuthenticationService(controlStorage);
    const control = new PlatformControlPlaneService(controlStorage, storageRegistry, appAuthentication);
    return {
        stores,
        identityStores,
        control,
        appAuthentication,
        sessionAccess: new SessionAccessService(
            appAuthentication,
            control,
            new SessionAccessSigner(environment.MORTY_SESSION_SIGNING_SECRET),
        ),
        projects: new PlatformProjectStorageDirectory(storageRegistry, controlStorage),
    };
}

export function createPlatformApplication(
    authentication: PlatformAuthenticationConfiguration,
    gateways: (environment: PlatformApplicationBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: PlatformApplicationBindings }> {
    const controlHandler: Handler<DispatchEnvironment> = (context) =>
        controlApplication.fetch(context.req.raw, {
            control: context.var.control,
            appAuthentication: context.var.appAuthentication,
            allowedOrigins: authentication.allowedOrigins,
        });
    const projectHandler: Handler<DispatchEnvironment> = (context) =>
        scopedProjectApplication.fetch(context.req.raw, {
            relay: context.var.relay,
            allowedOrigins: authentication.allowedOrigins,
        });

    const controlRoutes = new Hono<DispatchEnvironment>()
        .all("/health", controlHandler)
        .all("/capabilities", controlHandler)
        .route(
            "/v1",
            new Hono<DispatchEnvironment>()
                .post("/machine-accounts", controlHandler)
                .all("/platform/*", controlHandler)
                .route(
                    "/accounts/:accountId",
                    new Hono<DispatchEnvironment>()
                        .all("/storage-placement", controlHandler)
                        .all("/storage-placement/", controlHandler)
                        .all("/audit-events", controlHandler)
                        .all("/audit-events/", controlHandler)
                        .all("/sessions/*", controlHandler),
                ),
        );
    const sessionRoutes = new Hono<DispatchEnvironment>()
        .use(
            "*",
            createBrowserCors(
                ["GET", "POST", "PUT"],
                [
                    "authorization",
                    "content-type",
                    "x-morty-byte-length",
                    "x-morty-content-kind",
                    "x-morty-file-name",
                    "x-morty-oidc-provider",
                ],
                authentication.allowedOrigins,
            ),
        )
        .post("/:sessionId/access-credentials", sessionAccessTargetMiddleware, async (context) => {
            const authorization = context.req.header("authorization") ?? "";
            const credential = authorization.match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "project_credential_required", message: "An App credential is required" } },
                    401,
                );
            }
            const body: unknown = await context.req.json();
            const input = v.parse(
                v.strictObject({
                    expiresInSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(60), v.maxValue(900)),
                    runtimeId: sessionIdentifier,
                }),
                body,
            );
            const access = await context.var.sessionAccess.issue(
                context.var.sessionAccessTarget,
                input.runtimeId,
                credential,
                input.expiresInSeconds,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(access, 201);
        })
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
            // The public shape of this answer, not the internal access record: it names no AppCredential.
            return context.json({
                expiresAtEpochMilliseconds: target.expiresAtEpochMilliseconds,
                issuedAtEpochMilliseconds: target.issuedAtEpochMilliseconds,
                kind: "expiring",
                accountId: target.accountId,
                runtimeId: target.runtimeId,
            });
        })
        .get("/:sessionId/native-events-preview", sessionAccessTargetMiddleware, async (context) => {
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const eventLimit = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                Number(context.req.query("eventLimit") ?? "50"),
            );
            const control = authorizedSessionControl(context, access, sessionId);
            const events = await control.previewEvents(sessionBindingQuery(context.req), {
                cursor: context.req.query("cursor") ?? null,
                eventLimit,
            });
            context.header("Cache-Control", "no-store");
            return context.json(events);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const binding = sessionBindingQuery(context.req);
            const commandId = context.req.query("commandId");
            const control = authorizedSessionControl(context, access, sessionId);
            const result = await control.activeTurn(
                binding,
                commandId === undefined ? undefined : v.parse(sessionIdentifier, commandId),
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const body = decodeSessionRequest(turnSubmissionRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
            const accepted = await control.submitTurn({ ...body, commandId: body.idempotencyKey });
            const acceptedAt = new Date().toISOString();
            context.header("Cache-Control", "no-store");
            return context.json({
                acceptedAt,
                bindingId: "workspace",
                idempotencyKey: body.idempotencyKey,
                request: {
                    content: body.content,
                    kind: "prompt",
                    sessionConfigurations: body.sessionConfigurations,
                },
                sessionId,
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
            decodeSessionRequest(turnSteerRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const path = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), context.req.query("path"));
            const maxBytes = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(128 * 1024 * 1024)),
                Number(context.req.query("maxBytes") ?? String(32 * 1024 * 1024)),
            );
            return await sessionOperations(context).readProjectSessionFile(
                new AccountScope(access.accountId),
                access.runtimeId,
                decodeFileReadCommand(
                    JSON.stringify({ kind: "file.read", maxBytes, path, requestId: crypto.randomUUID(), sessionId }),
                ),
                context.req.raw.signal,
            );
        })
        .put("/:sessionId/content/:contentKey", async (context) => {
            const authorized = await authorizeSessionContentUpload(context.req.raw, context.var.sessionAccess);
            if (authorized instanceof Response) {
                return authorized;
            }
            const { access, sessionId, contentKey } = authorized;
            const byteLength = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(CONTENT_WRITE_MAX_BYTES)),
                Number(context.req.header("x-morty-byte-length") ?? ""),
            );
            const contentKind = v.parse(v.picklist(["image", "resource"]), context.req.header("x-morty-content-kind"));
            const mediaType = v.parse(
                v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
                context.req.header("content-type"),
            );
            const encodedName = v.parse(
                v.pipe(v.string(), v.minLength(1), v.maxLength(1_500)),
                context.req.header("x-morty-file-name"),
            );
            const uri = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)), context.req.query("uri"));
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
            name = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), name);
            const available = await sessionOperations(context).writeProjectSessionContent(
                new AccountScope(access.accountId),
                access.runtimeId,
                decodeContentWriteCommand(
                    JSON.stringify({
                        byteLength,
                        contentKey,
                        contentKind,
                        kind: "content.write",
                        mediaType,
                        name,
                        requestId: crypto.randomUUID(),
                        sessionId,
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const body = decodeSessionRequest(sessionConfigurationRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const body = decodeSessionRequest(sessionRenameRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
            const control = authorizedSessionControl(context, access, sessionId);
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
            const sessionId = v.parse(sessionIdentifier, context.req.param("sessionId"));
            const interactionId = v.parse(sessionIdentifier, context.req.param("interactionId"));
            const body = decodeSessionRequest(interactionResponseRequest, await context.req.json());
            const control = authorizedSessionControl(context, access, sessionId);
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
                const events = await authorizedSessionControl(
                    context,
                    target,
                    v.parse(sessionIdentifier, context.req.param("sessionId")),
                ).liveEvents({
                    cursor: context.req.query("cursor") ?? null,
                    eventLimit: v.parse(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                        Number(context.req.query("limit") ?? "50"),
                    ),
                });
                context.header("Cache-Control", "no-store");
                return context.json(events);
            }
            return await sessionOperations(context).openPublicSessionEvents(
                new AccountScope(target.accountId),
                target.runtimeId,
                context.req.param("sessionId"),
                {
                    credentialId: target.credentialId,
                    signingKeyId: target.signingKeyId,
                    issuedAt: target.issuedAtEpochMilliseconds,
                    expiresAt: target.expiresAtEpochMilliseconds,
                },
                context.req.raw.signal,
            );
        });
    const sessionAccessRoutes = new Hono<DispatchEnvironment>().post("/revocations", async (context) => {
        const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
        if (credential === undefined) {
            return context.json(
                { error: { code: "project_credential_required", message: "An App credential is required" } },
                401,
            );
        }
        v.parse(v.strictObject({}), await context.req.json());
        if (!("MORTY_ACCOUNT_STORE" in context.env)) {
            throw new Error("Session access is revoked only in the Project's AccountDO");
        }
        const accountId = validateIdentifier(context.req.param("accountId") ?? "", "project_id");
        const store = context.env.MORTY_ACCOUNT_STORE;
        const channel = gateways(context.env).channel;
        const revoked = await context.var.sessionAccess.revoke(
            accountId,
            credential,
            {
                runtimeIds: async (signal) => (await store.listRuntimes(signal)).map((runtime) => runtime.runtime_id),
                disconnect: (runtimeId, revokedThrough, signal) =>
                    channel.disconnectSessionViewers(accountId, runtimeId, revokedThrough, signal),
            },
            context.req.raw.signal,
        );
        context.header("Cache-Control", "no-store");
        return context.json(revoked);
    });
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route("/sessions", sessionRoutes)
        .route("/session-access", sessionAccessRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/*", projectHandler)
        .all("/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/accounts/:accountId", projectRoutes)
        .all("/runtime-pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", projectHandler);

    const application = new Hono<DispatchEnvironment>()
        .use("*", errorMiddleware)
        .use("*", requestTimeoutMiddleware<DispatchEnvironment>(PLATFORM_REQUEST_TIMEOUT_MILLISECONDS))
        .use("*", async (context, next) => {
            const runtimeRoute = await routeRuntimeSessionRequest(context.req.raw, context.env);
            if (runtimeRoute !== null) {
                return runtimeRoute;
            }
            const routed =
                "MORTY_RUNTIME_EXECUTION" in context.env
                    ? null
                    : await routeAccountDurableObject(context.req.raw, context.env, authentication.allowedOrigins);
            if (routed !== null) {
                return routed;
            }
            return await next();
        })
        .onError((error) => {
            throw error;
        })
        .use("*", async (context, next) => {
            const environment = context.env;
            const { stores, identityStores, control, appAuthentication, sessionAccess, projects } =
                createPlatformAccessServices(environment);
            context.set("control", control);
            context.set("appAuthentication", appAuthentication);
            context.set("sessionAccess", sessionAccess);
            context.set("stores", stores);
            context.set("projects", projects);
            context.set("identityStores", identityStores);
            await next();
        })
        .route(`${MORTY_API_PREFIX}/dashboard`, controlRoutes)
        .use("*", initializeSessionAccessTargetMiddleware)
        .use("*", async (context, next) => {
            const environment = context.env;
            const { control, stores, projects, identityStores } = context.var;
            const cx = createWorkerContext({
                applications: control,
                gateways: gateways(environment),
                authorization: control,
                stores,
                identityStores,
                projects,
                apiPrefix: MORTY_API_PREFIX,
            });
            context.set("relay", cx);
            await next();
        })
        .route(MORTY_API_PREFIX, new Hono<DispatchEnvironment>().route("/v1", versionedRoutes))
        .all("*", (context) => projectApplication.fetch(context.req.raw, context.var.relay));
    const platformApplication: Hono<{ Bindings: PlatformApplicationBindings }> = new Hono<{
        Bindings: PlatformApplicationBindings;
    }>()
        .onError((error) => {
            throw error;
        })
        .all("*", async (context) => {
            const metrics = new RequestAccessMetrics();
            return metrics.appendServerTiming(
                await application.fetch(
                    context.req.raw,
                    instrumentPlatformDatabases(context.env, metrics),
                    optionalExecutionContext(context),
                ),
            );
        });
    return platformApplication;
}

function instrumentPlatformDatabases(
    environment: PlatformRelayBindings,
    metrics: RequestAccessMetrics,
): PlatformRelayBindings {
    return {
        ...environment,
        PLATFORM_DIRECTORY_DATABASE: instrumentD1Database(environment.PLATFORM_DIRECTORY_DATABASE, metrics),
    };
}

export function createPlatformGateways(environment: PlatformApplicationBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
        ...("MORTY_RUNTIME_EXECUTION" in environment
            ? { runtimeOperations: environment.MORTY_RUNTIME_EXECUTION.operations }
            : {}),
    };
}

export function createPlatformWorker() {
    const configuredApplications = new Map<string, ReturnType<typeof createPlatformApplication>>();
    return {
        fetch: async (
            request: Request,
            environment: ConfiguredPlatformRelayBindings,
            executionContext?: ExecutionContext,
        ): Promise<Response> => {
            const key = environment.MORTY_ALLOWED_ORIGINS;
            const configured = configuredApplications.get(key);
            if (configured !== undefined) {
                return await configured.fetch(request, environment, executionContext);
            }
            const created = createPlatformApplication(
                platformAuthenticationFromEnvironment(environment),
                createPlatformGateways,
            );
            configuredApplications.set(key, created);
            return await created.fetch(request, environment, executionContext);
        },
    };
}

const worker = createPlatformWorker();

export { platformAuthenticationFromEnvironment } from "./composition/platform-authentication-environment.ts";
export { PlatformAuthenticationConfiguration } from "./entity/platform-control-plane.ts";
export { RuntimeRelay };
export default worker;
