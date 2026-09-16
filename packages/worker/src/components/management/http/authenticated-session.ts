import { createMiddleware } from "hono/factory";
import type { Session } from "../entity/authentication/session.ts";
import { ManagementError } from "../entity/management-error.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export const authenticatedSession = createMiddleware<
    ManagementHttpEnvironment & { Variables: { readonly session: Session } }
>(async (context, next) => {
    const timing = context.get("operationTiming");
    const authenticate = () =>
        context.env.services.authentication.session(context.get("bearerToken"), context.req.raw.signal);
    const result =
        timing === undefined
            ? await authenticate()
            : await timing.measure("authentication", "Authenticate request", authenticate);
    switch (result.kind) {
        case "authenticated":
            context.set("session", result.session);
            await next();
            return;
        case "unauthenticated":
            throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        case "unavailable":
            throw new ManagementError("AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable.", 503);
    }
});
