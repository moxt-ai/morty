import { validateIdentifier } from "@morty-build/relay-core";
import type { MiddlewareHandler } from "hono";
import type { SessionAccessTarget } from "../service/session-access-service.ts";

interface SessionAccessTargetEnvironment {
    readonly Variables: { readonly sessionAccessTarget: SessionAccessTarget };
}

export const initializeSessionAccessTargetMiddleware: MiddlewareHandler<SessionAccessTargetEnvironment> = async (
    context,
    next,
) => {
    context.set("sessionAccessTarget", { kind: "unavailable" });
    await next();
};

export const sessionAccessTargetMiddleware: MiddlewareHandler<SessionAccessTargetEnvironment> = async (
    context,
    next,
) => {
    context.set("sessionAccessTarget", {
        kind: "session",
        computerId: validateIdentifier(context.req.param("computerId") ?? "", "project_id"),
        target: {
            harness: validateIdentifier(context.req.param("harness") ?? "", "harness"),
            sessionId: validateIdentifier(context.req.param("sessionId") ?? "", "session_id"),
        },
    });
    await next();
};
