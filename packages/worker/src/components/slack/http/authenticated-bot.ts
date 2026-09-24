import { createMiddleware } from "hono/factory";
import { type BotPrincipal, IdentityError } from "../service/identity/identity-service.ts";
import { type TenantContext, tenantContext } from "../service/identity/tenant-context.ts";
import type { SlackHttpEnvironment } from "./slack-http-environment.ts";

export type AuthenticatedBotVariables = {
    readonly principal: BotPrincipal;
    readonly tenant: TenantContext;
};

export const authenticatedBot = createMiddleware<
    SlackHttpEnvironment & { readonly Variables: AuthenticatedBotVariables }
>(async (context, next) => {
    const bearerToken = context.get("bearerToken");
    if (bearerToken === undefined) {
        throw new IdentityError("AUTHENTICATION_FAILED", "Bearer credential is required");
    }
    const principal = await context.env.services.identities.authenticateBot(bearerToken, context.req.raw.signal);
    context.set("principal", principal);
    context.set("tenant", tenantContext(principal.tenantId));
    await next();
});
