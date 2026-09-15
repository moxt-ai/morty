import { Hono } from "hono";
import * as v from "valibot";
import {
    botBindingInputSchema,
    botSetupCredentialSchema,
    configureBotSchema,
    createMobiusBotSchema,
    pairingStatusInputSchema,
} from "../../../../gateway/mobius-gateway";
import { humanTenant, tenantContext } from "../../service/identity/tenant-context";
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
        .post("/mobius/projects/:projectId/bots/:botId/setup/read", authenticatedHuman, async (context) => {
            const input = v.parse(botSetupCredentialSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.botSetup(
                    context.req.param("projectId"),
                    context.req.param("botId"),
                    input.ownerCredential,
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .post("/mobius/projects/:projectId/bots/:botId/setup", authenticatedHuman, async (context) => {
            const input = v.parse(configureBotSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.configureBot(
                    context.req.param("projectId"),
                    context.req.param("botId"),
                    input,
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
                202,
            );
        })
        .post("/mobius/pairings", authenticatedHuman, async (context) => {
            const principal = context.get("principal");
            const pairing = await context.env.gateways.mobius.createPairing(
                context.get("forwardingToken"),
                context.req.raw.signal,
                principal.tenantId,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ ...pairing, relayUrl: context.env.config.mobiusBaseUrl }, 201);
        })
        .post("/mobius/pairings/status", authenticatedHuman, async (context) => {
            const input = v.parse(pairingStatusInputSchema, await context.req.json());
            context.header("Cache-Control", "no-store");
            return context.json(await context.env.gateways.mobius.pairingStatus(input, context.req.raw.signal));
        })
        .get("/mobius/projects/:projectId/status", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.gateways.mobius.projectStatus(
                    context.req.param("projectId"),
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/mobius/projects", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.gateways.mobius.listProjects(context.get("forwardingToken"), context.req.raw.signal),
            );
        })
        .get("/mobius/projects/:projectId/bots", authenticatedHuman, async (context) => {
            return context.json(
                await context.env.gateways.mobius.listProjectBots(
                    context.req.param("projectId"),
                    context.get("forwardingToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .post("/mobius/projects/:projectId/bots", authenticatedHuman, async (context) => {
            const input = v.parse(createMobiusBotSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.createBot(
                    context.req.param("projectId"),
                    context.get("forwardingToken"),
                    input,
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .get("/bots", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            return context.json({
                bots: await management.listBots(humanTenant(principal), context.req.raw.signal),
            });
        })
        .put("/bots/:slackBotId/binding", authenticatedHuman, async (context) => {
            const { mobiusConnections: mobius } = context.env.services;
            const principal = context.get("principal");
            const body = v.parse(botBindingInputSchema, await context.req.json());
            return context.json(
                await mobius.bind(
                    humanTenant(principal),
                    principal,
                    context.req.param("slackBotId"),
                    body,
                    context.req.raw.signal,
                ),
            );
        })
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
            const { installations } = context.env.services;
            const principal = context.get("principal");
            const query = v.parse(botQuerySchema, context.req.query());
            return context.json({
                url: await installations.createAuthorizationUrl(
                    humanTenant(principal),
                    {
                        botId: query.slackBotId,
                        humanId: principal.humanId,
                        tenantId: principal.tenantId,
                    },
                    context.req.raw.signal,
                ),
            });
        })
        .get("/oauth/callback", async (context) => {
            const { slackTokens: tokens, installations } = context.env.services;
            const code = context.req.query("code");
            const state = context.req.query("state");
            const error = context.req.query("error");
            if (error !== undefined || code === undefined || state === undefined) {
                return context.redirect(
                    `/oauth-result?status=error&error=${encodeURIComponent(error ?? "missing_oauth_parameters")}`,
                );
            }
            const verified = await tokens.readOAuthState(state, context.req.raw.signal);
            const tenant = tenantContext(verified.tenantId);
            await installations.completeAuthorization(tenant, code, verified, context.req.raw.signal);
            return context.redirect("/oauth-result?status=success");
        })
        .get("/manifest", authenticatedHuman, (context) => {
            const { management } = context.env.services;
            const name = v.parse(v.pipe(v.string(), v.minLength(1)), context.req.query("name"));
            return context.json(management.manifest(name));
        })
        .post("/apps/register", authenticatedHuman, async (context) => {
            const { management, installations } = context.env.services;
            const principal = context.get("principal");
            const body = v.parse(registerAppBodySchema, await context.req.json());
            const tenant = humanTenant(principal);
            await management.registerManualApp(tenant, principal, body, context.req.raw.signal);
            const url = await installations.createAuthorizationUrl(
                tenant,
                {
                    botId: body.slackBotId,
                    humanId: principal.humanId,
                    tenantId: principal.tenantId,
                },
                context.req.raw.signal,
            );
            return context.json({ oauthAuthorizeUrl: url }, 201);
        })
        .post("/apps", authenticatedHuman, async (context) => {
            const { management, installations } = context.env.services;
            const principal = context.get("principal");
            const body = v.parse(createAppBodySchema, await context.req.json());
            const tenant = humanTenant(principal);
            const created = await management.createApp(tenant, principal, body, context.req.raw.signal);
            const oauthAuthorizeUrl = await installations.createAuthorizationUrl(
                tenant,
                {
                    botId: body.slackBotId,
                    humanId: principal.humanId,
                    tenantId: principal.tenantId,
                },
                context.req.raw.signal,
            );
            return context.json({ ...created, oauthAuthorizeUrl }, 201);
        })
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
        .put("/config-token", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            const body = v.parse(configTokenBodySchema, await context.req.json());
            await management.saveConfigToken(
                humanTenant(principal),
                principal,
                body.refreshToken,
                context.req.raw.signal,
            );
            return context.body(null, 204);
        })
        .delete("/config-token", authenticatedHuman, async (context) => {
            const { management } = context.env.services;
            const principal = context.get("principal");
            await management.deleteConfigToken(humanTenant(principal), principal, context.req.raw.signal);
            return context.body(null, 204);
        });
}
