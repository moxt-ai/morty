import { PairingDirectoryError, type PairingTenantResolver } from "@moxt-ai/mobius-relay-core";
import type { AuthenticationService } from "../service/authentication-service.ts";

export class MobiusPairingTenantResolver implements PairingTenantResolver {
    readonly #authentication: AuthenticationService;

    constructor(cx: { readonly services: { readonly authentication: AuthenticationService } }) {
        this.#authentication = cx.services.authentication;
    }

    readonly resolve: PairingTenantResolver["resolve"] = async (request, signal) => {
        const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
        const result = await this.#authentication.session(token, signal);
        if (result.kind === "unauthenticated") {
            throw new PairingDirectoryError("unauthorized", "A signed-in workspace is required");
        }
        if (result.kind === "unavailable") {
            throw new PairingDirectoryError("pairing_tenant_unavailable", "Workspace identity is unavailable");
        }
        if (result.session.organizationId === null) {
            throw new PairingDirectoryError("workspace_required", "Select a workspace before pairing");
        }
        if (result.session.placement === null) {
            throw new PairingDirectoryError("pairing_tenant_unavailable", "Workspace storage is unavailable");
        }
        return result.session.organizationId;
    };
}
