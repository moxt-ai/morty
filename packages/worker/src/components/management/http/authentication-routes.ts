import * as v from "valibot";
import { projectObject } from "../../../gateway/project-object-routing.ts";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectLocationHint } from "../util/project-location.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const transferInput = v.pipe(v.object({ code: v.string() }), v.readonly());
const pairingInput = v.object({ botId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)) });
const pairingRedemptionInput = v.object({ token: v.string() });
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
            const project = await context.env.gateways.platformProjects.create(
                userId,
                "Personal workspace",
                signal,
                projectLocationHint(context.req.raw),
            );
            const response = await projectObject(context.env.config.bindings, project.projectId).fetch(
                new Request("https://project.internal/__project/bootstrap", {
                    body: JSON.stringify({ project, userId }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
            signal.throwIfAborted();
            return response;
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
        .post(
            "/identity/pairings",
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
                const input = context.req.valid("json");
                const ticket = await context.env.services.management.createAgentPairing(
                    context.get("bearerToken"),
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
            },
        )
        .post(
            "/identity/pairings/redeem",
            bodyParser<ManagementHttpEnvironment, typeof pairingRedemptionInput>(pairingRedemptionInput),
            async (context) => {
                const input = context.req.valid("json");
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
                return json(await context.env.services.management.redeemAgentPairing(input.token, signal), 200, {
                    "Cache-Control": "no-store",
                });
            },
        )
        .post(
            "/identity/transfers/redeem",
            bodyParser<ManagementHttpEnvironment, typeof transferInput>(transferInput),
            async (context) => {
                const input = context.req.valid("json");
                const identity = await context.env.services.authentication.redeemTransfer(
                    input.code,
                    context.req.raw.signal,
                );
                if (identity === null) {
                    throw new ManagementError(
                        "TRANSFER_UNAVAILABLE",
                        "This transfer link has expired or reached its five-use limit.",
                        410,
                    );
                }
                return json(identity);
            },
        )
        .delete("/identity/remote-access", async (context) => {
            const result = await context.env.services.authentication.endRemoteAccess(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended":
                    return new Response(null, { status: 204 });
                case "not-remote":
                    throw new ManagementError("REMOTE_ACCESS_REQUIRED", "This device is not using remote access.", 409);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
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
        .post(
            "/identity/clerk-binding",
            bodyParser<ManagementHttpEnvironment, typeof bindingInput>(bindingInput),
            async (context) => {
                const input = context.req.valid("json");
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
            },
        );
}

import { Hono } from "hono";
