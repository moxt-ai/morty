import { json } from "../infra/http.ts";
import type { CloudHttpEnvironment } from "./cloud-http-environment.ts";

function unavailable(): Response {
    return json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } }, 503);
}

export function createAuthenticationRoutes() {
    return new Hono<CloudHttpEnvironment>()
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
            const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
            const result = await context.env.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    return json(result.session);
                case "unauthenticated":
                    return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
                case "unavailable":
                    return unavailable();
            }
        });
}

import { Hono } from "hono";
