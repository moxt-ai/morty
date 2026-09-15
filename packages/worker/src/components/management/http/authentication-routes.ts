import * as v from "valibot";
import { createApplicationDependencies } from "../../../composition/application-context.ts";
import { projectBindings } from "../../../composition/chat-shards.ts";
import { json } from "../../../infra/http.ts";
import { ManagementError } from "../entity/management-error.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { projectLocationHint } from "./project-location.ts";
import { provisionUserBot } from "./user-bot-setup.ts";

const transferInput = v.pipe(v.object({ code: v.string() }), v.readonly());
const bindingInput = v.pipe(
    v.object({
        action: v.picklist(["bind", "discard-local", "override"]),
        anonymousToken: v.string(),
    }),
    v.readonly(),
);

function unavailable(): never {
    throw new ManagementError("AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable.", 503);
}

export function createAuthenticationRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .all("/config", (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                    Allow: "GET",
                });
            }
            const configuration = context.env.services.authentication.publicConfiguration();
            return configuration === null ? unavailable() : json(configuration);
        })
        .all("/session", async (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                    Allow: "GET",
                });
            }
            const token = context.get("bearerToken");
            const result = await context.env.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    return json(result.session);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "unavailable":
                    return unavailable();
            }
        })
        .post("/identity/anonymous-users", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            const userId = `usr_${crypto.randomUUID()}`;
            const gateway = context.env.gateways.platformProjects;
            const project = await gateway.create(
                userId,
                "Personal workspace",
                signal,
                context.env.config.bindings.MOBIUS_WORKER_REGION === "apac" ||
                    context.env.config.bindings.MOBIUS_WORKER_REGION === "wnam"
                    ? context.env.config.bindings.MOBIUS_WORKER_REGION
                    : projectLocationHint(context.req.raw),
            );
            const scoped = createApplicationDependencies(
                await projectBindings(context.env.config.bindings, project.projectId, signal),
            );
            const identity = await scoped.services.authentication.createAnonymous(userId, project.projectId, signal);
            const { origin, appId } = gateway.configuration();
            await scoped.storages.platformProjects.save(userId, origin, appId, project, signal);
            const bot = await provisionUserBot(scoped, identity.userId, signal, context.req.raw);
            return json({ ...identity, bot }, 201, { "Cache-Control": "no-store" });
        })
        .post("/identity/transfers", async (context) => {
            const transfer = await context.env.services.authentication.createTransfer(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            if (transfer === null) {
                throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
            }
            const url = new URL(
                "/continue",
                v.parse(v.pipe(v.string(), v.url()), context.env.config.bindings.APP_ORIGIN),
            );
            url.hash = `code=${transfer.code}`;
            return json({ expiresAt: new Date(transfer.expiresAt).toISOString(), url: url.toString() }, 201);
        })
        .post("/identity/pairings", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const input = v.parse(
                v.object({ botId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)) }),
                await context.req.json(),
            );
            const session = await context.env.services.authentication.session(context.get("bearerToken"), signal);
            if (session.kind === "unavailable") {
                return unavailable();
            }
            if (session.kind === "unauthenticated") {
                throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
            const bots = await context.env.storages.managedBots.listBots(session.session.userId, signal);
            if (!bots.some((bot) => bot.botId === input.botId)) {
                throw new ManagementError("BOT_NOT_FOUND", "Bot is unavailable.", 404);
            }
            const ticket = await context.env.services.authentication.createPairing(
                session.session.userId,
                input.botId,
                signal,
            );
            const url = new URL(
                "/pair.md",
                v.parse(v.pipe(v.string(), v.url()), context.env.config.bindings.APP_ORIGIN),
            );
            url.searchParams.set("token", ticket.code);
            return json({ url: url.toString(), expiresAt: new Date(ticket.expiresAt).toISOString() }, 201, {
                "Cache-Control": "no-store",
            });
        })
        .post("/identity/pairings/redeem", async (context) => {
            const input = v.parse(v.object({ token: v.string() }), await context.req.json());
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const identity = await context.env.services.authentication.redeemPairing(input.token, signal);
            if (identity === null) {
                throw new ManagementError(
                    "PAIRING_TICKET_UNAVAILABLE",
                    "Copy a fresh pairing instruction from your Chat page.",
                    410,
                );
            }
            const { origin, appId } = context.env.gateways.platformProjects.configuration();
            const project = await context.env.storages.platformProjects.read(identity.userId, origin, appId, signal);
            if (project === null) {
                throw new ManagementError("PROJECT_REQUIRED", "The Bot's Project is unavailable.", 409);
            }
            return json({ ...identity, projectId: project.projectId }, 200, { "Cache-Control": "no-store" });
        })
        .post("/identity/transfers/redeem", async (context) => {
            const input = v.parse(transferInput, await context.req.json());
            const identity = await context.env.services.authentication.redeemTransfer(
                input.code,
                context.req.raw.signal,
            );
            if (identity === null) {
                throw new ManagementError(
                    "TRANSFER_UNAVAILABLE",
                    "This transfer link has expired or has already been used.",
                    410,
                );
            }
            return json(identity);
        })
        .get("/identity/clerk-binding", async (context) => {
            const result = await context.env.services.authentication.clerkBinding(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            if (result === null) {
                throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
            return json(result);
        })
        .post("/identity/clerk-binding", async (context) => {
            const input = v.parse(bindingInput, await context.req.json());
            const result = await context.env.services.authentication.bindClerk(
                context.get("bearerToken"),
                input.anonymousToken,
                input.action,
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "bound":
                    return json(result);
                case "conflict":
                    throw new ManagementError(
                        "BINDING_CONFLICT",
                        "This account is already connected to another local user.",
                        409,
                    );
                case "invalid-local-user":
                    throw new ManagementError("INVALID_LOCAL_USER", "The local user cannot be connected.", 409);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
        });
}

import { Hono } from "hono";
