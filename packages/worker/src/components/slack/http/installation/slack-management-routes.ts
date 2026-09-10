import { Hono } from "hono";
import * as v from "valibot";
import {
    botBindingInputSchema,
    botSetupCredentialSchema,
    configureBotSchema,
    createMobiusBotSchema,
    pairingStatusInputSchema,
} from "../../gateway/mobius-gateway";
import { humanTenant, tenantContext } from "../../service/identity/tenant-context";
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
        .post("/mobius/projects/:projectId/bots/:botId/setup/read", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            const input = v.parse(botSetupCredentialSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.botSetup(
                    context.req.param("projectId"),
                    context.req.param("botId"),
                    input.ownerCredential,
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    context.req.raw.signal,
                ),
            );
        })
        .post("/mobius/projects/:projectId/bots/:botId/setup", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            const input = v.parse(configureBotSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.configureBot(
                    context.req.param("projectId"),
                    context.req.param("botId"),
                    input,
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    context.req.raw.signal,
                ),
                202,
            );
        })
        .post("/mobius/pairings", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            const principal = await context.env.services.identities.authenticateHuman(
                authorization,
                context.req.raw.signal,
            );
            const pairing = await context.env.gateways.mobius.createPairing(
                authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                context.req.raw.signal,
                principal.tenantId,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ ...pairing, relayUrl: context.env.config.mobiusBaseUrl }, 201);
        })
        .post("/mobius/pairings/status", async (context) => {
            await context.env.services.identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            const input = v.parse(pairingStatusInputSchema, await context.req.json());
            context.header("Cache-Control", "no-store");
            return context.json(await context.env.gateways.mobius.pairingStatus(input, context.req.raw.signal));
        })
        .get("/mobius/projects/:projectId/status", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            return context.json(
                await context.env.gateways.mobius.projectStatus(
                    context.req.param("projectId"),
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    context.req.raw.signal,
                ),
            );
        })
        .get("/mobius/projects", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            return context.json(
                await context.env.gateways.mobius.listProjects(
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    context.req.raw.signal,
                ),
            );
        })
        .get("/mobius/projects/:projectId/bots", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            return context.json(
                await context.env.gateways.mobius.listProjectBots(
                    context.req.param("projectId"),
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    context.req.raw.signal,
                ),
            );
        })
        .post("/mobius/projects/:projectId/bots", async (context) => {
            const authorization = context.req.header("authorization") ?? null;
            await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
            const input = v.parse(createMobiusBotSchema, await context.req.json());
            return context.json(
                await context.env.gateways.mobius.createBot(
                    context.req.param("projectId"),
                    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
                    input,
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .get("/bots", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            return context.json({
                bots: await management.listBots(humanTenant(principal), context.req.raw.signal),
            });
        })
        .put("/bots/:slackBotId/binding", async (context) => {
            const { identities, mobiusConnections: mobius } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
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
        .get("/me", async (context) => {
            const { identities } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            return context.json(principal);
        })
        .get("/status", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            const query = v.parse(botQuerySchema, context.req.query());
            return context.json(
                await management.status(humanTenant(principal), principal, query.slackBotId, context.req.raw.signal),
            );
        })
        .get("/oauth/url", async (context) => {
            const { identities, installations } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
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
        .get("/manifest", async (context) => {
            const { identities, management } = context.env.services;
            await identities.authenticateHuman(context.req.header("authorization") ?? null, context.req.raw.signal);
            const name = v.parse(v.pipe(v.string(), v.minLength(1)), context.req.query("name"));
            return context.json(management.manifest(name));
        })
        .post("/apps/register", async (context) => {
            const { identities, management, installations } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
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
        .post("/apps", async (context) => {
            const { identities, management, installations } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
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
        .delete("/apps/:slackBotId", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            await management.disconnect(
                humanTenant(principal),
                principal,
                context.req.param("slackBotId"),
                context.req.raw.signal,
            );
            return context.body(null, 204);
        })
        .get("/config-token", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            return context.json(
                await management.configTokenStatus(humanTenant(principal), principal, context.req.raw.signal),
            );
        })
        .put("/config-token", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            const body = v.parse(configTokenBodySchema, await context.req.json());
            await management.saveConfigToken(
                humanTenant(principal),
                principal,
                body.refreshToken,
                context.req.raw.signal,
            );
            return context.body(null, 204);
        })
        .delete("/config-token", async (context) => {
            const { identities, management } = context.env.services;
            const principal = await identities.authenticateHuman(
                context.req.header("authorization") ?? null,
                context.req.raw.signal,
            );
            await management.deleteConfigToken(humanTenant(principal), principal, context.req.raw.signal);
            return context.body(null, 204);
        });
}
