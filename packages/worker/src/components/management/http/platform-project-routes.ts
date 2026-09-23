import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
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
