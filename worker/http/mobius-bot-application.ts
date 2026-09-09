import { createBotApplication } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { botErrorResponse } from "../../mobius/packages/relay-core/src/http/bot/bot-error-response.ts";
import { pathIdentifier } from "../../mobius/packages/relay-core/src/http/bot/bot-input.ts";
import type { BotService } from "../../mobius/packages/relay-core/src/service/bot/bot-service.ts";

export function createCloudBotApplication() {
    return new Hono<{ readonly Bindings: { readonly services: { readonly bots: BotService } } }>()
        .onError((error, c) => {
            c.req.raw.signal.throwIfAborted();
            return botErrorResponse(error);
        })
        .get("/mobius/api/v1/projects/:projectId/bots", async (c) => {
            const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
            const tenant = await c.env.services.bots.resolveTenant(c.req.raw, signal);
            return c.json({
                bots: await c.env.services.bots.listProjectBots(
                    tenant,
                    pathIdentifier(c.req.param("projectId")),
                    signal,
                ),
            });
        })
        .route("/", createBotApplication());
}
