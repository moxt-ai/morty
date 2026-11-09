import {
    decodeAgentSettingsDiscoverCommand,
    decodeNativeSessionRequest,
    decodeSessionCloseCommand,
    decodeSessionCreateCommand,
    decodeSessionCreationReadCommand,
    decodeSessionListCommand,
    decodeSessionPrepareCommand,
    decodeSessionQueryCommand,
    decodeSessionRestoreCommand,
    decodeWorkspaceListCommand,
    type Identifier,
    isDirectoryIdentifier,
    isIdentifier,
    MAX_DIRECTORY_IDENTIFIER_LENGTH,
    RUNTIME_WORKSPACE_BINDING_ID,
} from "@morty-build/client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    validateIdentifier,
} from "../../entity/pairing/pairing.ts";
import { assertRequiredKeys, bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";
import {
    createProjectRuntimeSessionControlRoutes,
    sessionControl,
    sessionTarget,
} from "./project-runtime-session-control-routes.ts";
import {
    decodeSessionRequest,
    sessionBindingEntries,
    sessionConfigurationRequest,
    sessionRenameRequest,
    turnAttachmentsSchema,
    turnSubmissionEntries,
} from "./session-requests.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const sessionIdentitySchema = v.strictObject({
    agentId: identifier,
    directoryId: v.custom<string>(isDirectoryIdentifier),
});
const sessionBindingSchema = v.strictObject(sessionBindingEntries);
const createSessionSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    // The Runtime validates each selection; the Relay only bounds the request.
    configurations: v.pipe(v.array(v.unknown()), v.maxLength(100)),
    computerId: identifier,
    operationId: identifier,
});
const nativeEventsSchema = v.strictObject({
    ...sessionBindingSchema.entries,
    cursor: v.nullable(v.string()),
    eventLimit: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
});
const nativeForkSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    sessionId: identifier,
});
const sessionQuerySchema = v.strictObject({
    targets: v.pipe(
        v.array(v.strictObject({ harness: identifier, sessionId: identifier })),
        v.minLength(1),
        v.maxLength(500),
    ),
});
const sessionRestoreSchema = v.strictObject({});
const sessionListQuerySchema = v.strictObject({
    limit: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,2}$/), v.transform(Number), v.safeInteger(), v.maxValue(500)),
});
const browserCredentialSchema = v.strictObject({
    expiresInSeconds: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000),
        v.maxValue(MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000),
    ),
});
// The Runtime API also lets a caller choose the Turn's history policy, and accepts the earlier envelope that named
// images and resources separately.
const runtimeTurnEntries = {
    ...turnSubmissionEntries,
};
const runtimeTurnRequest = v.union([
    v.strictObject({ ...runtimeTurnEntries, attachments: turnAttachmentsSchema }),
    v.strictObject({ ...runtimeTurnEntries, images: v.array(v.unknown()), resources: v.array(v.unknown()) }),
]);

function validated<TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
    value: Readonly<Record<string, unknown>>,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new PairingDirectoryError("invalid_request", "The request fields are invalid", { cause: result.issues });
    }
    return result.output;
}

export function createProjectRuntimeRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .route("/", createProjectRuntimeSessionControlRoutes())
        .post("/computers/:computerId/browser-credentials", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = validated(browserCredentialSchema, context.req.valid("json"));
            return context.json(
                await context.env.services.runtimePairings.createBrowserCredential(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    body.expiresInSeconds * 1_000,
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .delete("/computers/:computerId/browser-credentials/:credentialId", async (context) => {
            await context.env.services.runtimePairings.revokeBrowserCredential(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                validateIdentifier(context.req.param("credentialId"), "credential_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        })
        .get("/computers/:computerId/latency", async (context) => {
            await context.env.services.runtimePairings.probeProject(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.body(null, 204);
        })
        .get("/computers/:computerId/runtimes", async (context) => {
            const runtimes = await context.env.services.runtimePairings.listProjectRuntimes(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ runtimes });
        })
        .get("/computers/:computerId/daemon/agents", async (context) => {
            const runtime = await context.env.services.runtimePairings.getRuntimeAgents(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(runtime);
        })
        .get("/computers/:computerId/daemon/diagnostics", async (context) => {
            const result = await context.env.services.runtimePairings.readRuntimeDiagnostics(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .get("/computers/:computerId/daemon/latency", async (context) => {
            const latencyMs = await context.env.services.runtimePairings.measureRuntimeLatency(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ latencyMs });
        })
        .get("/computers/:computerId/daemon/sessions", async (context) => {
            const query = validated(sessionListQuerySchema, { limit: context.req.query("limit") ?? "100" });
            const command = decodeSessionListCommand(
                JSON.stringify({
                    kind: "session.list",
                    limit: query.limit,
                    requestId: crypto.randomUUID(),
                }),
            );
            const result = await context.env.services.runtimePairings.requestControl(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                bearerToken(context.req.raw),
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .get("/computers/:computerId/daemon/session-creations/:operationId", async (context) => {
            const result = await context.env.services.runtimePairings.requestControl(
                validateIdentifier(context.req.param("computerId"), "project_id"),

                bearerToken(context.req.raw),
                decodeSessionCreationReadCommand(
                    JSON.stringify({
                        kind: "session.creation.read",
                        requestId: crypto.randomUUID(),
                        operationId: validateIdentifier(context.req.param("operationId"), "operation_id"),
                    }),
                ),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/computers/:computerId/daemon/sessions/query", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = validated(sessionQuerySchema, context.req.valid("json"));
            const command = decodeSessionQueryCommand(
                JSON.stringify({
                    kind: "session.query",
                    requestId: crypto.randomUUID(),
                    targets: body.targets,
                }),
            );
            const result = await context.env.services.runtimePairings.requestControl(
                validateIdentifier(context.req.param("computerId"), "project_id"),

                bearerToken(context.req.raw),
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/computers/:computerId/daemon/sessions", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = validated(createSessionSchema, context.req.valid("json"));
            if (body.computerId !== context.req.param("computerId")) {
                throw new PairingDirectoryError("invalid_request", "The Runtime identifier does not match");
            }
            const command = decodeSessionCreateCommand(
                JSON.stringify({
                    ...body,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    kind: "session.create",
                    requestId: crypto.randomUUID(),
                }),
            );
            const result = await context.env.services.runtimePairings.requestControl(
                validateIdentifier(context.req.param("computerId"), "project_id"),

                bearerToken(context.req.raw),
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/load",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(sessionIdentitySchema, context.req.valid("json"));
                const command = decodeSessionPrepareCommand(
                    JSON.stringify({
                        ...body,
                        bindingId: "workspace",
                        kind: "session.prepare",
                        requestId: crypto.randomUUID(),
                        target: sessionTarget(context),
                        sessionState: "provisioned",
                    }),
                );
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/restore",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(sessionRestoreSchema, context.req.valid("json"));
                const command = decodeSessionRestoreCommand(
                    JSON.stringify({
                        kind: "session.restore",
                        requestId: crypto.randomUUID(),
                        target: {
                            harness: validateIdentifier(context.req.param("harness"), "harness"),
                            sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                        },
                    }),
                );
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/close",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(sessionRestoreSchema, context.req.valid("json"));
                const command = decodeSessionCloseCommand(
                    JSON.stringify({
                        kind: "session.close",
                        requestId: crypto.randomUUID(),
                        target: sessionTarget(context),
                    }),
                );
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .get("/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/configuration", async (context) => {
            const result = await sessionControl(context).readConfiguration();
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/configuration",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = decodeSessionRequest(sessionConfigurationRequest, context.req.valid("json"));
                const result = await sessionControl(context).configure(body);
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/rename",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = decodeSessionRequest(sessionRenameRequest, context.req.valid("json"));
                const result = await sessionControl(context).rename(body.title);
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/native-events-preview",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(nativeEventsSchema, context.req.valid("json"));
                const events = await sessionControl(context).previewEvents(body, body);
                context.header("Cache-Control", "no-store");
                return context.json(events);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/active-turn",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(sessionBindingSchema, context.req.valid("json"));
                const result = await sessionControl(context).activeTurn(body);
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/turns",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = decodeSessionRequest(runtimeTurnRequest, context.req.valid("json"));
                const accepted = await sessionControl(context).submitTurn({
                    ...body,
                    attachments: "attachments" in body ? body.attachments : [],
                    commandId: body.idempotencyKey,
                });
                context.header("Cache-Control", "no-store");
                return context.json({ turnId: accepted.commandId });
            },
        )
        .post(
            "/computers/:computerId/daemon/agents/:agentId/settings",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = context.req.valid("json");
                if (Object.keys(body).some((key) => key !== "model" && key !== "directoryId")) {
                    throw new PairingDirectoryError("invalid_request", "The request fields are invalid");
                }
                const model = body["model"] === undefined ? undefined : readString(body, "model", 500);
                const directoryId =
                    body["directoryId"] === undefined
                        ? undefined
                        : readString(body, "directoryId", MAX_DIRECTORY_IDENTIFIER_LENGTH);
                const command = decodeAgentSettingsDiscoverCommand(
                    JSON.stringify({
                        agentId: validateIdentifier(context.req.param("agentId"), "agent_id"),
                        ...(directoryId === undefined ? {} : { directoryId }),
                        kind: "agent.settings.discover",
                        ...(model === undefined ? {} : { model }),
                        requestId: crypto.randomUUID(),
                    }),
                );
                const result = await context.env.services.runtimePairings.discoverAgentSettings(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/computers/:computerId/daemon/native-session-forks/:operationId",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const result = await context.env.services.runtimePairings.forkNativeSession(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("operationId"), "operation_id"),
                    validated(nativeForkSchema, context.req.valid("json")),
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post("/computers/:computerId/daemon/native-sessions", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = context.req.valid("json");
            if (body["action"] !== "list" && body["action"] !== "find" && body["action"] !== "import") {
                throw new PairingDirectoryError("invalid_request", "Choose a supported native session operation");
            }
            assertRequiredKeys(
                body,
                body["action"] === "list"
                    ? ["action", "agentId", "directoryId", "cursor", "discoveryId"]
                    : body["action"] === "find"
                      ? ["action", "agentId", "directoryId", "sessionId"]
                      : ["action", "agentId", "directoryId", "entryId", "discoveryId"],
            );
            const { discoveryId: requestedDiscoveryId, ...input } = body;
            const discoveryId =
                (input["action"] === "list" && requestedDiscoveryId === null) || input["action"] === "find"
                    ? crypto.randomUUID()
                    : validateIdentifier(readString(body, "discoveryId"), "discovery_id");
            const command = decodeNativeSessionRequest(
                JSON.stringify({
                    ...input,
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    discoveryId,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                }),
            );
            const result = await context.env.services.runtimePairings.requestControl(
                validateIdentifier(context.req.param("computerId"), "project_id"),

                bearerToken(context.req.raw),
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .post("/computers/:computerId/daemon/workspace", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = context.req.valid("json");
            assertRequiredKeys(body, ["directoryId"]);
            const view = body["view"];
            if (view !== undefined && view !== "metadata") {
                throw new PairingDirectoryError("invalid_request", "The workspace view is invalid");
            }
            const command = decodeWorkspaceListCommand(
                JSON.stringify({
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    directoryId: readString(body, "directoryId", MAX_DIRECTORY_IDENTIFIER_LENGTH),
                    kind: "workspace.list",
                    requestId: crypto.randomUUID(),
                    ...(view === undefined ? {} : { view }),
                }),
            );
            const result = await context.env.services.runtimePairings.listWorkspace(
                validateIdentifier(context.req.param("computerId"), "project_id"),

                bearerToken(context.req.raw),
                command,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        });
}
