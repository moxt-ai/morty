import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { createApplicationDependencies } from "../../../composition/application-context.ts";
import { projectBindings } from "../../../composition/chat-shards.ts";
import { json } from "../../../infra/http.ts";
import { ManagementError } from "../entity/management-error.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { projectLocationHint } from "./project-location.ts";

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
            const { origin, appId } = context.env.gateways.platformProjects.configuration();
            return json({
                project: await context.env.storages.platformProjects.read(
                    session.userId,
                    origin,
                    appId,
                    AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]),
                ),
            });
        })
        .post("/project", authenticatedSession, async (context) => {
            const session = context.get("session");
            if (context.get("mediaType") !== "application/json") {
                throw new ManagementError("INVALID_REQUEST", "A JSON request is required.", 400);
            }
            let body: unknown;
            try {
                body = await context.req.json();
            } catch (cause) {
                context.req.raw.signal.throwIfAborted();
                if (cause instanceof SyntaxError) {
                    throw new ManagementError("INVALID_REQUEST", "The JSON request is invalid.", 400);
                }
                throw cause;
            }
            const input = v.parse(inputSchema, body);
            const { origin, appId } = context.env.gateways.platformProjects.configuration();
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const existing = await context.env.storages.platformProjects.read(session.userId, origin, appId, signal);
            if (existing !== null) {
                return json({ project: existing });
            }
            const project = await context.env.gateways.platformProjects.create(
                session.userId,
                input.displayName,
                signal,
                projectLocationHint(context.req.raw),
            );
            const scoped = createApplicationDependencies(
                await projectBindings(context.env.config.bindings, project.projectId, signal),
            );
            await scoped.storages.platformProjects.save(session.userId, origin, appId, project, signal);
            context.env.logger.info(
                { event: "platform-project-provisioned", userId: session.userId, projectId: project.projectId },
                "Project audit event",
            );
            return json({
                project: await scoped.storages.platformProjects.read(session.userId, origin, appId, signal),
            });
        });
}
