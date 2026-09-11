import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const inputSchema = v.strictObject({ displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)) });
const tokenSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4096), v.regex(/^[^\s]+$/u));

export function createPlatformProjectRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .use(
            "/project",
            bodyLimit({
                maxSize: 4096,
                onError: () => json({ error: { code: "INVALID_REQUEST", message: "The request is too large." } }, 413),
            }),
        )
        .get("/project", async (context) => {
            const session = await authenticatedSession(context.env, context.req.raw);
            if (session instanceof Response) {
                return session;
            }
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
        .post("/project", async (context) => {
            const session = await authenticatedSession(context.env, context.req.raw);
            if (session instanceof Response) {
                return session;
            }
            if (session.authentication.kind !== "clerk") {
                return json(
                    { error: { code: "CLERK_REQUIRED", message: "Sign in with Clerk to provision a Project." } },
                    403,
                );
            }
            if (context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
                return json({ error: { code: "INVALID_REQUEST", message: "A JSON request is required." } }, 400);
            }
            let body: unknown;
            try {
                body = await context.req.json();
            } catch (cause) {
                context.req.raw.signal.throwIfAborted();
                if (cause instanceof SyntaxError) {
                    return json({ error: { code: "INVALID_REQUEST", message: "The JSON request is invalid." } }, 400);
                }
                throw cause;
            }
            const input = v.parse(inputSchema, body);
            const token = v.parse(tokenSchema, context.req.header("x-mobius-developer-token"));
            const { origin, appId } = context.env.gateways.platformProjects.configuration();
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const existing = await context.env.storages.platformProjects.read(session.userId, origin, appId, signal);
            if (existing !== null) {
                return json({ project: existing });
            }
            const project = await context.env.gateways.platformProjects.create(
                session.userId,
                input.displayName,
                token,
                signal,
            );
            await context.env.storages.platformProjects.save(session.userId, origin, appId, project, signal);
            context.env.logger.info(
                { event: "platform-project-provisioned", userId: session.userId, projectId: project.projectId },
                "Project audit event",
            );
            return json({
                project: await context.env.storages.platformProjects.read(session.userId, origin, appId, signal),
            });
        });
}
