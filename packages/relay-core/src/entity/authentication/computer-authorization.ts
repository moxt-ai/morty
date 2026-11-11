import type { SessionAccessGrant } from "@morty-build/client/protocol";
import type { ComputerAccessContext, ComputerPermission } from "./computer-authentication.ts";

/** Internal authorization of an already selected computer at the execution boundary. */
export interface ComputerAccessAuthorizer {
    readonly authorizeComputer: (
        computerId: string,
        requiredPermission: ComputerPermission,
        signal: AbortSignal,
    ) => Promise<ComputerAccessContext>;
}

/**
 * The host's current answer for a computer credential that opened a long-lived connection. It applies the same rule
 * as `ComputerAccessAuthorizer`, so revoking, rotating or descoping the credential ends what the connection may do.
 */
export interface ComputerCredentialAuthority {
    readonly grants: (
        computerId: string,
        requiredPermissions: readonly ComputerPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
    /**
     * The current authority for a live Session view, checked against the same holder and Runtime pairing
     * generation as HTTP requests. Ending either authority ends the view.
     */
    readonly grantsSessionCredential: (
        computerId: string,
        grant: SessionAccessGrant,
        requiredPermissions: readonly ComputerPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
}
