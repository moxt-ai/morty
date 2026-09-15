import { createMiddleware } from "hono/factory";
import type { HumanPrincipal } from "../service/identity/identity-service";
import type { SlackHttpEnvironment } from "./slack-http-environment";

export const authenticatedHuman = createMiddleware<
    SlackHttpEnvironment & {
        Variables: {
            readonly principal: HumanPrincipal;
            readonly forwardingToken: string | null;
        };
    }
>(async (context, next) => {
    const authorization = context.req.header("authorization") ?? null;
    const principal = await context.env.services.identities.authenticateHuman(authorization, context.req.raw.signal);
    context.set("principal", principal);
    context.set("forwardingToken", authorization?.startsWith("Bearer ") ? authorization.slice(7) : null);
    await next();
});
