import { Hono } from "hono";
import * as v from "valibot";
import {
    botBindingInputSchema,
    botSetupCredentialSchema,
    configureBotSchema,
    createMobiusBotSchema,
    pairingStatusInputSchema,
} from "../../../../gateway/mobius-gateway";
import { bodyParser } from "../../../../middleware/body-parser.ts";
import { humanTenant } from "../../service/identity/tenant-context";
import { authenticatedHuman } from "../authenticated-human";
import type { SlackHttpEnvironment } from "../slack-http-environment";

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
        .post(
            "/mobius/projects/:projectId/bots/:botId/setup/read",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof botSetupCredentialSchema>(botSetupCredentialSchema),
            async (context) => {
                const input = context.req.valid("json");
                return context.json(
                    await context.env.services.mobiusConnections.readBotSetup(
                        context.req.param("projectId"),
                        context.req.param("botId"),
                        input.ownerCredential,
                        context.get("forwardingToken"),
                        context.req.raw.signal,
                    ),
                );
            },
        )
        .post(
            "/mobius/projects/:projectId/bots/:botId/setup",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof configureBotSchema>(configureBotSchema),
            async (context) => {
                const input = context.req.valid("json");
                return context.json(
                    await context.env.services.mobiusConnections.configureBot(
                        context.req.param("projectId"),
                        context.req.param("botId"),
                        input,
                        context.get("forwardingToken"),
                        context.req.raw.signal,
                    ),
                    202,
                );
            },
        )
        .post("/mobius/pairings", authenticatedHuman, async (context) => {
            const principal = context.get("principal");
            const pairing = await context.env.services.mobiusConnections.createPairing(
                context.get("forwardingToken"),
                principal.tenantId,
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(pairing, 201);
        })
        .post(
            "/mobius/pairings/status",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof pairingStatusInputSchema>(pairingStatusInputSchema),
            async (context) => {
                const input = context.req.valid("json");
                context.header("Cache-Control", "no-store");
                return context.json(
                    await context.env.services.mobiusConnections.pairingStatus(input, context.req.raw.signal),
                );
            },
        )
        .get("/mobius/projects/:projectId/status", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.services.mobiusConnections.projectStatus(
                    context.req.param("projectId"),
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/mobius/projects", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.services.mobiusConnections.listProjects(
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/mobius/projects/:projectId/bots", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.services.mobiusConnections.listProjectBots(
                    context.req.param("projectId"),
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .post(
            "/mobius/projects/:projectId/bots",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof createMobiusBotSchema>(createMobiusBotSchema),
            async (context) => {
                const input = context.req.valid("json");
                return context.json(
                    await context.env.services.mobiusConnections.createBot(
                        context.req.param("projectId"),
                        context.get("forwardingToken"),
                        input,
                        context.req.raw.signal,
                    ),
                    201,
                );
            },
        )
        .get("/bots", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            return context.json({
                bots: await management.listBots(humanTenant(principal), context.req.raw.signal),
            });
        })
        .put(
            "/bots/:slackBotId/binding",
            authenticatedHuman,
            bodyParser<SlackHttpEnvironment, typeof botBindingInputSchema>(botBindingInputSchema),
            async (context) => {
                const { mobiusConnections: mobius } = context.env.services;
                const principal = context.get("principal");
                const body = context.req.valid("json");
                return context.json(
                    await mobius.bind(
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
