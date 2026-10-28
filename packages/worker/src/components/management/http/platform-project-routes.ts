import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { projectObject } from "../../../gateway/project-object-routing.ts";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectLocationHint } from "../util/project-location.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const inputSchema = v.strictObject({ displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)) });

export function createPlatformProjectRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .use(
            "/project",
            bodyLimit({
                maxSize: 4096,
                onError: () => {
                    throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
                },
            }),
        )
        .get("/project", authenticatedSession, async (context) => {
            const session = context.get("session");
            const { appId } = context.env.gateways.platformProjects.configuration();
            return json({
                appId,
                project: await context.env.services.management.readProject(
                    session.userId,
                    AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]),
                ),
            });
        })
        .post("/project/replacement", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            const { authentication, management } = context.env.services;
            const local = await authentication.localIdentity(context.get("bearerToken"), signal);
            switch (local.kind) {
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the identity saved on the machine to replace its Project.",
                        403,
                    );
                case "local":
                    break;
            }
            // This optional correlation ID is untrusted diagnostics, never authorization.
            const setupRunId = v.safeParse(v.pipe(v.string(), v.uuid()), context.req.header("x-morty-setup-run-id"));
            const audit = {
                event: "project_replacement",
                previousProjectId: context.env.config.bindings.CHAT_PROJECT_ID,
                setupRunId: setupRunId.success ? setupRunId.output : null,
            };
            context.env.logger.info({ ...audit, stage: "requested" }, "Project replacement requested");
            try {
                const project = await management.replaceProject(local.userId, signal);
                // Repeating the same saved local identity reuses its successor credential, even if bootstrap
                // committed only part of its data. An explicitly revoked successor credential is never reissued.
                const response = await projectObject(context.env.config.bindings, project.projectId).fetch(
                    new Request("https://project.internal/__project/bootstrap", {
                        body: JSON.stringify({
                            project,
                            userId: local.userId,
                            replacement: { previousProjectId: audit.previousProjectId, token: local.token },
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal,
                    }),
                );
                signal.throwIfAborted();
                if (!response.ok) {
                    context.env.logger.warn(
                        { ...audit, projectId: project.projectId, stage: "bootstrap_failed", status: response.status },
                        "Project replacement did not reach access revocation",
                    );
                    return response;
                }
                // Keep the local identity until setup has saved the successor, so a lost reply can be retried.
                const revoked = await authentication.revokeAllAccess(local.token, signal);
                if (revoked.kind !== "revoked") {
                    throw new ManagementError("UNAUTHENTICATED", "Local identity is no longer available.", 401);
                }
                context.env.logger.info(
                    { ...audit, projectId: project.projectId, stage: "access_revoked" },
                    "Earlier shared access revoked by Project replacement",
                );
                return response;
            } catch (cause) {
                // Do not log request bodies, credentials, or arbitrary remote error messages. A failed response
                // cannot prove whether a request already changed access, so leave the outcome unconfirmed.
                context.env.logger.warn(
                    { ...audit, stage: "outcome_unconfirmed" },
                    "Project replacement did not return a confirmed result",
                );
                throw cause;
            }
        })
        .post(
            "/project",
            authenticatedSession,
            bodyParser<ManagementHttpEnvironment, typeof inputSchema>(inputSchema),
            async (context) => {
                const session = context.get("session");
                const input = context.req.valid("json");
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
                return json({
                    project: await context.env.services.management.createProject(
                        session.userId,
                        input.displayName,
                        projectLocationHint(context.req.raw),
                        signal,
                    ),
                });
            },
        );
}
