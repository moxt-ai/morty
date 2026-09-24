import { createMiddleware } from "hono/factory";
import { type HumanPrincipal, IdentityError } from "../service/identity/identity-service";
import type { SlackHttpEnvironment } from "./slack-http-environment";

export const authenticatedHuman = createMiddleware<
    SlackHttpEnvironment & {
        Variables: {
            readonly principal: HumanPrincipal;
        };
    }
>(async (context, next) => {
    const bearerToken = context.get("bearerToken");
    if (bearerToken === undefined) {
        throw new IdentityError("AUTHENTICATION_FAILED", "Bearer credential is required");
    }
    const principal = await context.env.services.identities.authenticateHuman(bearerToken, context.req.raw.signal);
    context.set("principal", principal);
    await next();
});
