import type { MiddlewareHandler } from "hono";
import { validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { SessionAccessTarget } from "../service/session-access-service.ts";

interface SessionAccessTargetEnvironment {
    readonly Variables: { readonly sessionAccessTarget: SessionAccessTarget };
}

export const sessionAccessTargetMiddleware: MiddlewareHandler<SessionAccessTargetEnvironment> = async (
    context,
    next,
) => {
    context.set("sessionAccessTarget", {
        kind: "session",
        computerId: validateIdentifier(context.req.param("computerId") ?? "", "computer_id"),
        target: {
            harness: validateIdentifier(context.req.param("harness") ?? "", "harness"),
            sessionId: validateIdentifier(context.req.param("sessionId") ?? "", "session_id"),
        },
    });
    await next();
};
