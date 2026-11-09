import {
    decodeAgentSettingsDiscoverCommand,
    decodeNativeSessionRequest,
    decodeSessionArchiveCommand,
    decodeSessionCloseCommand,
    decodeSessionCreateCommand,
    decodeSessionCreationReadCommand,
    decodeSessionListCommand,
    decodeSessionPrepareCommand,
    decodeSessionQueryCommand,
    decodeSessionRestoreCommand,
    decodeWorkspaceListCommand,
    type Identifier,
    isDirectoryPath,
    isIdentifier,
    MAX_WORKSPACE_PATH_LENGTH,
} from "@morty-build/client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
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
    sessionConfigurationRequest,
    sessionRenameRequest,
    turnAttachmentsSchema,
    turnSubmissionEntries,
} from "./session-requests.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const sessionIdentitySchema = v.strictObject({
    harness: identifier,
    directory: v.custom<string>(isDirectoryPath),
});
const createSessionSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    // The Runtime validates each selection; the Relay only bounds the request.
    configurations: v.pipe(v.array(v.unknown()), v.maxLength(100)),
    computerId: identifier,
    operationId: identifier,
});
// The Agent's own history of a native session, read from the Agent directory the caller browses.
const nativeEventsSchema = v.strictObject({
    directory: v.custom<string>(isDirectoryPath),
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
// Operations whose request is the Session the path names, with no body fields.
const emptySessionRequestSchema = v.strictObject({});
const sessionListQuerySchema = v.strictObject({
    limit: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,2}$/), v.transform(Number), v.safeInteger(), v.maxValue(500)),
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
                validated(emptySessionRequestSchema, context.req.valid("json"));
                const command = decodeSessionPrepareCommand(
                    JSON.stringify({
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
                validated(emptySessionRequestSchema, context.req.valid("json"));
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
                validated(emptySessionRequestSchema, context.req.valid("json"));
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
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/archive",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(emptySessionRequestSchema, context.req.valid("json"));
                const command = decodeSessionArchiveCommand(
                    JSON.stringify({
                        kind: "session.archive",
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
                const events = await sessionControl(context).previewEvents(body.directory, body);
                context.header("Cache-Control", "no-store");
                return context.json(events);
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/active-turn",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(emptySessionRequestSchema, context.req.valid("json"));
                const result = await sessionControl(context).activeTurn();
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
            "/computers/:computerId/daemon/agents/:harness/settings",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = context.req.valid("json");
                if (Object.keys(body).some((key) => key !== "model" && key !== "directory")) {
                    throw new PairingDirectoryError("invalid_request", "The request fields are invalid");
                }
                const model = body["model"] === undefined ? undefined : readString(body, "model", 500);
                const directory =
                    body["directory"] === undefined
                        ? undefined
                        : readString(body, "directory", MAX_WORKSPACE_PATH_LENGTH);
                const command = decodeAgentSettingsDiscoverCommand(
                    JSON.stringify({
                        harness: validateIdentifier(context.req.param("harness"), "agent_id"),
                        ...(directory === undefined ? {} : { directory }),
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
                    ? ["action", "harness", "directory", "cursor"]
                    : body["action"] === "find"
                      ? ["action", "harness", "directory", "sessionId"]
                      : ["action", "harness", "directory", "sessionId"],
            );
            const command = decodeNativeSessionRequest(
                JSON.stringify({
                    ...body,
                    kind: "native.session.request",
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
        .post("/computers/:computerId/daemon/workspace", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = context.req.valid("json");
            assertRequiredKeys(body, ["directory"]);
            const view = body["view"];
            if (view !== undefined && view !== "metadata") {
                throw new PairingDirectoryError("invalid_request", "The workspace view is invalid");
            }
            const command = decodeWorkspaceListCommand(
                JSON.stringify({
                    directory: readString(body, "directory", MAX_WORKSPACE_PATH_LENGTH),
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
