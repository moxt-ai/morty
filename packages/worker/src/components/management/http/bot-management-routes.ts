import { Hono } from "hono";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { projectLocationHint } from "../util/project-location.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createBotManagementRoutes() {
    const createInput = v.strictObject({
        displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    });
    const updateInput = v.strictObject({
        displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
        instructions: v.pipe(v.string(), v.maxLength(100000)),
    });
    return new Hono<ManagementHttpEnvironment>()
        .get("/bots", authenticatedSession, async (context) => {
            const session = context.get("session");
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            return json({
                bots: await context.env.services.management.listBots(
                    session.userId,
                    projectLocationHint(context.req.raw),
                    signal,
                ),
            });
        })
        .post(
            "/bots",
            authenticatedSession,
            bodyParser<ManagementHttpEnvironment, typeof createInput>(createInput),
            async (context) => {
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
                return json(
                    await context.env.services.management.createBot(
                        context.get("session").userId,
                        context.req.valid("json").displayName,
                        signal,
                    ),
                    201,
                );
            },
        )
        .get("/bots/:botId", authenticatedSession, async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            return json(
                await context.env.services.management.readBot(
                    context.get("session").userId,
                    context.req.param("botId"),
                    signal,
                ),
            );
        })
        .get("/bots/:botId/runtime-binding", authenticatedSession, async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            return json(
                await context.env.services.management.readBotRuntimeBinding(
                    context.get("session").userId,
                    context.req.param("botId"),
                    signal,
                ),
            );
        })
        .patch(
            "/bots/:botId",
            authenticatedSession,
            bodyParser<ManagementHttpEnvironment, typeof updateInput>(updateInput),
            async (context) => {
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
                return json(
                    await context.env.services.management.updateBot(
                        context.get("session").userId,
                        context.req.param("botId"),
                        context.req.valid("json"),
                        signal,
                    ),
                );
            },
        )
        .delete("/bots/:botId", authenticatedSession, async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            await context.env.services.management.deleteBot(
                context.get("session").userId,
                context.req.param("botId"),
                signal,
            );
            return context.body(null, 204);
        });
}
