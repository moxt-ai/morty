import { Hono } from "hono";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { provisionUserBot } from "./user-bot-setup.ts";

const claimSchema = v.pipe(
    v.object({
        botId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)),
        displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
        ownerCredential: v.pipe(v.string(), v.minLength(32), v.maxLength(256)),
    }),
    v.readonly(),
);

export function createBotManagementRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .get("/bots", authenticatedSession, async (context) => {
            const session = context.get("session");
            await provisionUserBot(
                context.env,
                session.userId,
                AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]),
                context.req.raw,
            );
            return json({
                bots: await context.env.storages.managedBots.listBots(session.userId, context.req.raw.signal),
            });
        })
        .post("/bots/claims", authenticatedSession, async (context) => {
            const session = context.get("session");
            const input = v.parse(claimSchema, await context.req.json());
            const accessToken = await context.env.services.mobiusApp.issueAccessToken(
                input.botId,
                input.ownerCredential,
                context.req.raw.signal,
            );
            try {
                await context.env.storages.managedBots.saveClaim(
                    session.userId,
                    { botId: input.botId, displayName: input.displayName },
                    Date.now(),
                    context.req.raw.signal,
                );
            } finally {
                await context.env.services.mobiusApp.revokeAccessToken(
                    accessToken.accessTokenId,
                    AbortSignal.timeout(10_000),
                );
                context.req.raw.signal.throwIfAborted();
            }
            return json({ botId: input.botId, displayName: input.displayName }, 201);
        })
        .post("/access-tokens/:accessTokenId/regenerate", authenticatedSession, async (context) => {
            const session = context.get("session");
            const accessTokenId = context.req.param("accessTokenId");
            const botId = await context.env.storages.managedBots.accessTokenBot(
                session.userId,
                accessTokenId,
                context.req.raw.signal,
            );
            if (botId === null) {
                return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
            }
            return json(
                await context.env.services.mobiusApp.regenerateAccessToken(accessTokenId, context.req.raw.signal),
            );
        });
}
