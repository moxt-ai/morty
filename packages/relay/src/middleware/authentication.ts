import type { MiddlewareHandler } from "hono";
import { ComputerManagementError, type RelayPrincipal } from "../entity/computer-management.ts";
import type { AppCredentialAuthenticationService } from "../service/app-credential-authentication-service.ts";
import type { ComputerManagementService } from "../service/computer-management-service.ts";

export interface RelayAuthenticationEnvironment {
    readonly Bindings: {
        readonly control: ComputerManagementService;
        readonly appAuthentication: AppCredentialAuthenticationService;
    };
    readonly Variables: { readonly signal: AbortSignal; readonly principal: RelayPrincipal };
}

interface AuthenticationMethod {
    readonly accepts: (request: Request) => boolean;
    readonly middleware: MiddlewareHandler<RelayAuthenticationEnvironment>;
}

export const appCredentialAuthentication: AuthenticationMethod = {
    accepts: (request) => /^Bearer mapp_/iu.test(request.headers.get("authorization") ?? ""),
    middleware: async (context, next) => {
        if (context.req.header("x-morty-oidc-provider") !== undefined) {
            throw new ComputerManagementError("ambiguous_authentication", "Select one authentication method", 400);
        }
        const credential = context.req.header("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
        if (credential === undefined) {
            throw new ComputerManagementError("app_credential_invalid", "An App credential is required", 401);
        }
        context.set("principal", await context.env.appAuthentication.authenticate(credential, context.var.signal));
        await next();
    },
};

// Selection happens before verification: failures never fall through to another method.
export function authenticateWith(
    ...methods: readonly [AuthenticationMethod, ...AuthenticationMethod[]]
): MiddlewareHandler<RelayAuthenticationEnvironment> {
    return async (context, next) => {
        const method = methods.find((candidate) => candidate.accepts(context.req.raw));
        if (method === undefined) {
            throw new ComputerManagementError("authentication_required", "A supported credential is required", 401);
        }
        return await method.middleware(context, next);
    };
}
