import { Hono } from "hono";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { projectLocationHint } from "../util/project-location.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

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
            "/bots/claims",
            authenticatedSession,
            bodyParser<ManagementHttpEnvironment, typeof claimSchema>(claimSchema),
            async (context) => {
                const session = context.get("session");
                const input = context.req.valid("json");
                return json(
                    await context.env.services.management.claimBot(session.userId, input, context.req.raw.signal),
                    201,
                );
            },
        )
        .post("/access-tokens/:accessTokenId/regenerate", authenticatedSession, async (context) => {
            const session = context.get("session");
            const accessTokenId = context.req.param("accessTokenId");
            return json(
                await context.env.services.management.regenerateAccessToken(
                    session.userId,
                    accessTokenId,
                    context.req.raw.signal,
                ),
            );
        });
}
