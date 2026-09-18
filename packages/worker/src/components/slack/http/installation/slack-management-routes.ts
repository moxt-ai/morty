import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../../../../middleware/body-parser.ts";
import { humanTenant } from "../../service/identity/tenant-context";
import { authenticatedHuman } from "../authenticated-human";
import type { SlackHttpEnvironment } from "../slack-http-environment";

const chatBotBindingInputSchema = v.strictObject({
    botId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)),
});
const botQuerySchema = v.pipe(
    v.object({ slackBotId: v.pipe(v.string(), v.minLength(1)) }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const configTokenBodySchema = v.pipe(
    v.object({ refreshToken: v.pipe(v.string(), v.minLength(1)) }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const registerAppBodySchema = v.pipe(
    v.object({
        slackBotId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)),
        clientId: v.pipe(v.string(), v.minLength(1)),
        clientSecret: v.pipe(v.string(), v.minLength(1)),
        name: v.pipe(v.string(), v.minLength(1)),
        signingSecret: v.pipe(v.string(), v.minLength(1)),
        slackAppId: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const createAppBodySchema = v.pipe(
    v.object({
        slackBotId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)),
        name: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export function createSlackManagementRoutes() {
    return new Hono<SlackHttpEnvironment>()
        .get("/bots", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            return context.json({
                bots: await management.listBots(humanTenant(principal), context.req.raw.signal),
            });
        })
        .get("/chat-bots", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            return context.json({
                bots: await management.listOwnedBots(humanTenant(principal), context.req.raw.signal),
            });
        })
        .put(
            "/bots/:slackBotId/binding",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof chatBotBindingInputSchema>(chatBotBindingInputSchema),
            async (context) => {
                const { chatBotBindings } = context.env.services;
                const principal = context.get("principal");
                const body = context.req.valid("json");
                return context.json(
                    await chatBotBindings.bind(
                        humanTenant(principal),
                        principal,
                        context.req.param("slackBotId"),
                        body,
                        context.req.raw.signal,
                    ),
                );
            },
        )
        .get("/me", authenticatedHuman, (context) => {
            return context.json(context.get("principal"));
        })
        .get("/status", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            const query = v.parse(botQuerySchema, context.req.query());
            return context.json(
                await management.status(humanTenant(principal), principal, query.slackBotId, context.req.raw.signal),
            );
        })
        .get("/oauth/url", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            const query = v.parse(botQuerySchema, context.req.query());
            return context.json(
                await management.authorizationUrl(
                    humanTenant(principal),
                    principal,
                    query.slackBotId,
                    context.req.raw.signal,
                ),
            );
        })
        .get("/oauth/callback", async (context) => {
            const { management } = context.env.services;
            const code = context.req.query("code");
            const state = context.req.query("state");
            const error = context.req.query("error");
            if (error !== undefined || code === undefined || state === undefined) {
                return context.redirect(
                    `/oauth-result?status=error&error=${encodeURIComponent(error ?? "missing_oauth_parameters")}`,
                );
            }
            await management.completeAuthorization(code, state, context.req.raw.signal);
            return context.redirect("/oauth-result?status=success");
        })
        .get("/manifest", authenticatedHuman, (context) => {
            const { management } = context.env.services;
            const name = v.parse(v.pipe(v.string(), v.minLength(1)), context.req.query("name"));
            return context.json(management.manifest(name));
        })
        .post(
            "/apps/register",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof registerAppBodySchema>(registerAppBodySchema),
            async (context) => {
                const { management } = context.env.services;
                const principal = context.get("principal");
                const body = context.req.valid("json");
                const tenant = humanTenant(principal);
                return context.json(
                    await management.registerManualAppAndAuthorize(tenant, principal, body, context.req.raw.signal),
                    201,
                );
            },
        )
        .post(
            "/apps",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof createAppBodySchema>(createAppBodySchema),
            async (context) => {
                const { management } = context.env.services;
                const principal = context.get("principal");
                const body = context.req.valid("json");
                const tenant = humanTenant(principal);
                return context.json(
                    await management.createAppAndAuthorize(tenant, principal, body, context.req.raw.signal),
                    201,
                );
            },
        )
        .delete("/apps/:slackBotId", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            await management.disconnect(
                humanTenant(principal),
                principal,
                context.req.param("slackBotId"),
                context.req.raw.signal,
            );
            return context.body(null, 204);
        })
        .get("/config-token", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            return context.json(
                await management.configTokenStatus(humanTenant(principal), principal, context.req.raw.signal),
            );
        })
        .put(
            "/config-token",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof configTokenBodySchema>(configTokenBodySchema),
            async (context) => {
                const { management } = context.env.services;
                const principal = context.get("principal");
                const body = context.req.valid("json");
                await management.saveConfigToken(
                    humanTenant(principal),
                    principal,
                    body.refreshToken,
                    context.req.raw.signal,
                );
                return context.body(null, 204);
            },
        )
        .delete("/config-token", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            await management.deleteConfigToken(humanTenant(principal), principal, context.req.raw.signal);
            return context.body(null, 204);
        });
}
