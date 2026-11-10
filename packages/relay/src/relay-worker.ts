import {
    CONTENT_WRITE_MAX_BYTES,
    decodeContentWriteCommand,
    decodeFileReadCommand,
    type Identifier,
    isDirectoryPath,
    isIdentifier,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    type TurnState,
} from "@morty-build/client/protocol";
import type { LocalSessionOperations, ProjectStore } from "@morty-build/relay-core";
import {
    CloudflareChannelRuntime,
    ComputerScope,
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
    type RelayAuthenticationEnvironment,
    relayAuthenticationFromEnvironment,
} from "./composition/relay-authentication-environment.ts";
import type { RelayAuthenticationConfiguration } from "./entity/computer-management.ts";
import { SessionAccessSigner } from "./entity/session-access-credential.ts";
import {
    type ComputerDurableObjectExecutionBindings,
    type ComputerWorkerRoutingBindings,
    routeComputerDurableObject,
} from "./gateway/computer-durable-object-routing.ts";
import { ComputerDurableObjectStores } from "./gateway/computer-durable-object-store.ts";
import { routeRuntimeSessionRequest } from "./gateway/runtime-session-routing.ts";
import { createProjectApplication } from "./http/project-routes.ts";
import { authorizeSessionContentUpload } from "./http/session-content-upload.ts";
import { ComputerManagementStorageDirectory } from "./infra/computer-management-storage-directory.ts";
import { createBrowserCors } from "./middleware/browser-cors.ts";
import {
    initializeSessionAccessTargetMiddleware,
    sessionAccessTargetMiddleware,
} from "./middleware/session-access-target.ts";
import { ComputerManagementService } from "./service/computer-management-service.ts";
import {
    type SessionAccess,
    SessionAccessService,
    type SessionAccessTarget,
} from "./service/session-access-service.ts";
import { ComputerManagementStorage } from "./storage/computer-management-storage.ts";

export interface RelayRelayBindings extends ComputerWorkerRoutingBindings {
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
    /** Worker secret from which the Relay derives the keys that sign Session credentials. */
    readonly MORTY_SESSION_SIGNING_SECRET: string;
}

export interface ComputerRelayRelayBindings extends RelayRelayBindings, ComputerDurableObjectExecutionBindings {}

export interface RuntimeExecutionBindings extends RelayRelayBindings {
    readonly MORTY_RUNTIME_EXECUTION: {
        readonly computerId: string;
        readonly operations: LocalSessionOperations;
    };
}
type RelayApplicationBindings = RelayRelayBindings | ComputerRelayRelayBindings | RuntimeExecutionBindings;

export interface ConfiguredRelayRelayBindings extends RelayRelayBindings, RelayAuthenticationEnvironment {
    readonly APP_ORIGIN?: string;
    readonly MORTY_RELAY_URL?: string;
}

// A request a Session credential authorizes is routed to its ComputerRelay before any Session route runs.
function sessionOperations(context: { readonly env: RelayApplicationBindings }) {
    if (!("MORTY_RUNTIME_EXECUTION" in context.env)) {
        throw new Error("Session operations run only in the ComputerRelay");
    }
    return context.env.MORTY_RUNTIME_EXECUTION.operations;
}

function nativeTarget(request: { readonly param: (name: string) => string | undefined }): NativeSessionTarget {
    return {
        harness: validateIdentifier(request.param("harness") ?? "", "harness"),
        sessionId: validateIdentifier(request.param("sessionId") ?? "", "session_id"),
    };
}

/** Session operations on the Runtime a Session credential authorized. */
/** Session operations through a Session credential, each authorized for its own permission on that Session. */
function authorizedSessionControl(
    context: {
        readonly env: RelayApplicationBindings;
        readonly var: { readonly relay: RelayContext };
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

const projectApplication = createMortyApplication();
const scopedProjectApplication = createProjectApplication();
const RELAY_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const sessionIdentifier = v.custom<Identifier>(isIdentifier);

type DispatchEnvironment = {
    readonly Bindings: RelayApplicationBindings;
    readonly Variables: {
        readonly control: ComputerManagementService;
        readonly stores: ComputerDurableObjectStores;
        readonly projects: ComputerManagementStorageDirectory;
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

export function createRelayAccessServices(environment: RelayApplicationBindings) {
    const execution =
        "MORTY_COMPUTER_STORE" in environment
            ? { computerId: environment.MORTY_COMPUTER_ID, store: environment.MORTY_COMPUTER_STORE }
            : null;
    const stores = new ComputerDurableObjectStores(environment.COMPUTER_RELAY, execution);
    const identityStores = execution === null ? [] : [execution.store];
    const controlStorage = new ComputerManagementStorage(environment.RELAY_DIRECTORY_DATABASE, stores);
    const control = new ComputerManagementService(controlStorage);
    return {
        stores,
        identityStores,
        control,
        sessionAccess: new SessionAccessService(
            control,
            new SessionAccessSigner(environment.MORTY_SESSION_SIGNING_SECRET),
        ),
        projects: new ComputerManagementStorageDirectory(controlStorage),
    };
}

export function createRelayApplication(
    authentication: RelayAuthenticationConfiguration,
    gateways: (environment: RelayApplicationBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: RelayApplicationBindings }> {
    const projectHandler: Handler<DispatchEnvironment> = (context) =>
        scopedProjectApplication.fetch(context.req.raw, {
            relay: context.var.relay,
            allowedOrigins: authentication.allowedOrigins,
        });

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
                computerId: target.computerId,
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
            const sessionTarget = nativeTarget(context.req);
            const eventLimit = v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                Number(context.req.query("eventLimit") ?? "50"),
            );
            const control = authorizedSessionControl(context, access, sessionTarget);
            const directory = v.parse(v.custom<string>(isDirectoryPath), context.req.query("directory"));
            const events = await control.previewEvents(directory, {
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
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
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
            const path = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), context.req.query("path"));
            const maxBytes = v.parse(
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
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
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
            const turnId = v.parse(sessionIdentifier, context.req.param("turnId"));
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
            const interactionId = v.parse(sessionIdentifier, context.req.param("interactionId"));
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
                new ComputerScope(target.computerId),

                nativeTarget(context.req),
                {
                    signingKeyId: target.signingKeyId,
                    issuedAt: target.issuedAtEpochMilliseconds,
                    expiresAt: target.expiresAtEpochMilliseconds,
                },
                context.req.raw.signal,
            );
        });
    const projectRoutes = new Hono<DispatchEnvironment>()
        .route("/harnesses/:harness/sessions", sessionRoutes)
        .all("/pairings/*", projectHandler)
        .all("/*", projectHandler);
    const versionedRoutes = new Hono<DispatchEnvironment>()
        .route("/computers/:computerId", projectRoutes)
        .all("/pairings/*", projectHandler)
        .all("/runtimes/connect", projectHandler)
        .all("/*", projectHandler);

    const application = new Hono<DispatchEnvironment>()
        .use("*", errorMiddleware)
        .use("*", requestTimeoutMiddleware<DispatchEnvironment>(RELAY_REQUEST_TIMEOUT_MILLISECONDS))
        .use("*", async (context, next) => {
            const runtimeRoute = await routeRuntimeSessionRequest(context.req.raw, context.env);
            if (runtimeRoute !== null) {
                return runtimeRoute;
            }
            const routed =
                "MORTY_RUNTIME_EXECUTION" in context.env
                    ? null
                    : await routeComputerDurableObject(context.req.raw, context.env, authentication.allowedOrigins);
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
            const { stores, identityStores, control, sessionAccess, projects } = createRelayAccessServices(environment);
            context.set("control", control);
            context.set("sessionAccess", sessionAccess);
            context.set("stores", stores);
            context.set("projects", projects);
            context.set("identityStores", identityStores);
            await next();
        })
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
    const relayApplication: Hono<{ Bindings: RelayApplicationBindings }> = new Hono<{
        Bindings: RelayApplicationBindings;
    }>()
        .onError((error) => {
            throw error;
        })
        .all("*", async (context) => {
            const metrics = new RequestAccessMetrics();
            return metrics.appendServerTiming(
                await application.fetch(
                    context.req.raw,
                    instrumentRelayDatabases(context.env, metrics),
                    optionalExecutionContext(context),
                ),
            );
        });
    return relayApplication;
}

function instrumentRelayDatabases(environment: RelayRelayBindings, metrics: RequestAccessMetrics): RelayRelayBindings {
    return {
        ...environment,
        RELAY_DIRECTORY_DATABASE: instrumentD1Database(environment.RELAY_DIRECTORY_DATABASE, metrics),
    };
}

export function createRelayGateways(environment: RelayApplicationBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime(
            environment.COMPUTER_RELAY,
            "MORTY_COMPUTER_STORE" in environment ? environment.MORTY_LOCAL_CHANNEL : undefined,
        ),
        ...("MORTY_RUNTIME_EXECUTION" in environment
            ? { runtimeOperations: environment.MORTY_RUNTIME_EXECUTION.operations }
            : {}),
    };
}

export function createRelayWorker() {
    const configuredApplications = new Map<string, ReturnType<typeof createRelayApplication>>();
    return {
        fetch: async (
            request: Request,
            environment: ConfiguredRelayRelayBindings,
            executionContext?: ExecutionContext,
        ): Promise<Response> => {
            const key = environment.MORTY_ALLOWED_ORIGINS;
            const configured = configuredApplications.get(key);
            if (configured !== undefined) {
                return await configured.fetch(request, environment, executionContext);
            }
            const created = createRelayApplication(
                relayAuthenticationFromEnvironment(environment),
                createRelayGateways,
            );
            configuredApplications.set(key, created);
            return await created.fetch(request, environment, executionContext);
        },
    };
}

const worker = createRelayWorker();

export { relayAuthenticationFromEnvironment } from "./composition/relay-authentication-environment.ts";
export { RelayAuthenticationConfiguration } from "./entity/computer-management.ts";
export default worker;
