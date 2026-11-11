import type { SessionAccessGrant } from "@morty-build/client/protocol";
import type { ProjectAccessContext, ProjectPermission } from "./project-authentication.ts";

/** Internal authorization of an already selected computer at the execution boundary. */
export interface ProjectAccessAuthorizer {
    readonly authorizeProject: (
        computerId: string,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
}

/**
 * The host's current answer for a project credential that opened a long-lived connection. It applies the same rule
 * as `ProjectAccessAuthorizer`, so revoking, rotating or descoping the credential ends what the connection may do.
 */
export interface ProjectCredentialAuthority {
    readonly grants: (
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
    /**
     * The current authority for a live Session view, checked against the same holder and Computer pairing
     * generation as HTTP requests. Ending either authority ends the view.
     */
    readonly grantsSessionCredential: (
        computerId: string,
        grant: SessionAccessGrant,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
}
