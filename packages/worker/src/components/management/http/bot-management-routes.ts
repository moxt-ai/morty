import { Hono } from "hono";
import { json } from "../../../infra/http.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createBotManagementRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .get("/bot", authenticatedSession, async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            const bot = await context.env.services.management.userBot(context.get("session").userId, signal);
            return json({ botId: bot.botId, runtimeId: bot.runtimeId });
        })
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
        });
}
