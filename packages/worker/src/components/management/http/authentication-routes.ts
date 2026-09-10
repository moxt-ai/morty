import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const transferInput = v.pipe(v.object({ code: v.string() }), v.readonly());
const bindingInput = v.pipe(
    v.object({
        action: v.picklist(["bind", "discard-local", "override"]),
        anonymousToken: v.string(),
    }),
    v.readonly(),
);

function bearer(request: Request): string | undefined {
    return request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
}

function unavailable(): Response {
    return json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } }, 503);
}

export function createAuthenticationRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .all("/config", (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405, {
                    Allow: "GET",
                });
            }
            const configuration = context.env.services.authentication.publicConfiguration();
            return configuration === null ? unavailable() : json(configuration);
        })
        .all("/session", async (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405, {
                    Allow: "GET",
                });
            }
            const token = bearer(request);
            const result = await context.env.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    return json(result.session);
                case "unauthenticated":
                    return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
                case "unavailable":
                    return unavailable();
            }
        })
        .post("/identity/anonymous-users", async (context) =>
            json(await context.env.services.authentication.createAnonymous(context.req.raw.signal), 201),
        )
        .post("/identity/transfers", async (context) => {
            const transfer = await context.env.services.authentication.createTransfer(
                bearer(context.req.raw),
                context.req.raw.signal,
            );
            if (transfer === null) {
                return json({ error: { code: "UNAUTHENTICATED", message: "Anonymous identity is required." } }, 401);
            }
            const url = new URL(
                "/continue",
                v.parse(v.pipe(v.string(), v.url()), context.env.config.bindings.APP_ORIGIN),
            );
            url.hash = `code=${transfer.code}`;
            return json({ expiresAt: new Date(transfer.expiresAt).toISOString(), url: url.toString() }, 201);
        })
        .post("/identity/transfers/redeem", async (context) => {
            const input = v.parse(transferInput, await context.req.json());
            const identity = await context.env.services.authentication.redeemTransfer(
                input.code,
                context.req.raw.signal,
            );
            return identity === null
                ? json(
                      {
                          error: {
                              code: "TRANSFER_UNAVAILABLE",
                              message: "This transfer link has expired or has already been used.",
                          },
                      },
                      410,
                  )
                : json(identity);
        })
        .get("/identity/clerk-binding", async (context) => {
            const result = await context.env.services.authentication.clerkBinding(
                bearer(context.req.raw),
                context.req.raw.signal,
            );
            return result === null
                ? json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401)
                : json(result);
        })
        .post("/identity/clerk-binding", async (context) => {
            const input = v.parse(bindingInput, await context.req.json());
            const result = await context.env.services.authentication.bindClerk(
                bearer(context.req.raw),
                input.anonymousToken,
                input.action,
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "bound":
                    return json(result);
                case "conflict":
                    return json(
                        {
                            error: {
                                code: "BINDING_CONFLICT",
                                message: "This account is already connected to another local user.",
                            },
                        },
                        409,
                    );
                case "invalid-local-user":
                    return json(
                        { error: { code: "INVALID_LOCAL_USER", message: "The local user cannot be connected." } },
                        409,
                    );
                case "unauthenticated":
                    return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
            }
        });
}

import { Hono } from "hono";
