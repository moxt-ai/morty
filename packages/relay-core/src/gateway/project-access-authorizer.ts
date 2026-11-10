import type { SessionAccessGrant } from "@morty-build/client/protocol";
import type { ProjectAccessContext, ProjectPermission } from "../entity/authentication/project-authentication.ts";

/** The host authenticates an opaque credential and authorizes a resolved Project. */
export interface ProjectAccessAuthorizer {
    readonly authorizeProject: (
        computerId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorReference: string,
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
        credentialId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
    /**
     * The host's current answer for a Session credential the project credential issued with `grant`, which opened a
     * live Session view: the same rule its requests apply, so revoking the project credential, ending the holder's
     * access or revoking the Runtime pairing it was issued under ends the view.
     */
    readonly grantsSessionCredential: (
        computerId: string,
        credentialId: string,
        grant: SessionAccessGrant,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
}
