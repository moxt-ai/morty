import { createMiddleware } from "hono/factory";
import { json } from "../../../infra/http.ts";
import type { Session } from "../entity/authentication/session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export const authenticatedSession = createMiddleware<
    ManagementHttpEnvironment & { Variables: { readonly session: Session } }
>(async (context, next) => {
    const result = await context.env.services.authentication.session(
        context.get("bearerToken"),
        context.req.raw.signal,
    );
    switch (result.kind) {
        case "authenticated":
            context.set("session", result.session);
            await next();
            return;
        case "unauthenticated":
            return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
        case "unavailable":
            return json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } }, 503);
    }
});
