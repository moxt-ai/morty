import { createMiddleware } from "hono/factory";
import type { Session } from "../entity/authentication/session.ts";
import { ManagementError } from "../entity/management-error.ts";
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
        case "revoked":
            throw credentialRejected(result.kind);
    }
});

/**
 * The answer for a credential that does not authenticate. Revoked access keeps the UNAUTHENTICATED code that released
 * pages read and names its reason, so a page can tell that its access ended from a credential it never held.
 */
export function credentialRejected(kind: "unauthenticated" | "revoked"): ManagementError {
    switch (kind) {
        case "unauthenticated":
            return new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        case "revoked":
            return new ManagementError(
                "UNAUTHENTICATED",
                "Access to this computer has ended.",
                401,
                {},
                {
                    reason: "ACCESS_REVOKED",
                },
            );
    }
}
