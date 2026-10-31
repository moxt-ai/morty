import { createMiddleware } from "hono/factory";
import type { LocalOperation } from "../entity/authentication/credential.ts";
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

/** Admits only the machine's local credential, for an operation no shared or recovery access may perform. */
export const localSession = (operation: LocalOperation) =>
    createMiddleware<ManagementHttpEnvironment & { Variables: { readonly session: Session } }>(
        async (context, next) => {
            const result = await context.env.services.authentication.authorize(
                context.get("bearerToken"),
                operation,
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "authorized":
                    context.set("session", {
                        authentication: { kind: "anonymous" },
                        userId: result.credential.userId,
                    });
                    await next();
                    return;
                case "unauthenticated":
                case "revoked":
                    throw credentialRejected(result.kind);
                case "forbidden":
                    throw localIdentityRequired();
            }
        },
    );

export function localIdentityRequired(): ManagementError {
    return new ManagementError(
        "LOCAL_IDENTITY_REQUIRED",
        "Use the identity saved on the machine for this operation.",
        403,
    );
}

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
