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
            const project = await management.replaceProject(local.userId, signal);
            const response = await projectObject(context.env.config.bindings, project.projectId).fetch(
                new Request("https://project.internal/__project/bootstrap", {
                    body: JSON.stringify({ project, userId: local.userId }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
            signal.throwIfAborted();
            if (!response.ok) {
                return response;
            }
            // The successor holds the user's access from now on, so nothing shared from this Project opens it any
            // more. The local identity stays until setup has saved the successor's and ends it itself: a reply lost on
            // the way can be asked for again.
            await authentication.revokeAllAccess(local.token, signal);
            return response;
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
