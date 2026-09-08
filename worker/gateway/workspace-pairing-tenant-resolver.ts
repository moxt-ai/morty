import { PairingDirectoryError, type PairingTenantResolver } from "@moxt-ai/mobius-relay-core";
import type { AuthenticationService } from "../service/authentication-service.ts";

export class WorkspacePairingTenantResolver implements PairingTenantResolver {
    private readonly authentication: AuthenticationService;

    constructor(authentication: AuthenticationService) {
        this.authentication = authentication;
    }

    readonly resolve = async (request: Request, signal: AbortSignal): Promise<string> => {
        const authorization = request.headers.get("Authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        const result = await this.authentication.session(token, signal);
        switch (result.kind) {
            case "unavailable":
                throw new PairingDirectoryError(
                    "pairing_tenant_unavailable",
                    "Workspace authentication is unavailable",
                );
            case "unauthenticated":
                throw new PairingDirectoryError("unauthorized", "Sign in to create a pairing");
            case "authenticated":
                if (result.session.organizationId === null) {
                    throw new PairingDirectoryError("workspace_required", "Select a workspace to create a pairing");
                }
                return result.session.organizationId;
        }
    };
}
