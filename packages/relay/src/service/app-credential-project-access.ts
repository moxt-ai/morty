import type { SessionAccessHolder } from "@morty-build/client/protocol";
import {
    AuditActor,
    ComputerScope,
    PerpetualProjectAccessLifetime,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectCredentialAuthority,
    type ProjectPermission,
} from "@morty-build/relay-core";
import { RelayAuditActorKind } from "../entity/computer-management.ts";
import type { CredentialRow } from "../entity/relay-records.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { appCredentialActive, credentialPermissions } from "./app-credential-authentication-service.ts";

/**
 * What an authenticated AppCredential may do in a Project. Requests apply it once; a connection the credential
 * opened applies it again for every message, so both observe a revocation, rotation or Project deletion.
 */
export class AppCredentialProjectAccess implements ProjectCredentialAuthority {
    readonly #storage: Pick<
        ComputerManagementStorage,
        "holdsAccess" | "readActiveComputerScope" | "readCredentialById" | "scopedProjects"
    >;

    constructor(
        storage: Pick<
            ComputerManagementStorage,
            "holdsAccess" | "readActiveComputerScope" | "readCredentialById" | "scopedProjects"
        >,
    ) {
        this.#storage = storage;
    }

    readonly authorize = async (
        row: CredentialRow,
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.#storage.readActiveComputerScope(computerId, signal);
        if (project === null || project.app_id !== row.app_id) {
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The AppCredential is not authorized for this Project",
            );
        }
        if (row.all_projects !== 1) {
            const hasProject =
                (await this.#storage.scopedProjects(row.credential_id, [computerId], signal)).length === 1;
            if (!hasProject) {
                throw new ProjectAuthenticationError(
                    "project_access_denied",
                    "The AppCredential is not authorized for this Project",
                );
            }
        }
        const granted = credentialPermissions(row).granted;
        if (!requiredPermissions.every((permission) => granted.has(permission))) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The AppCredential does not grant this Project permission",
            );
        }
        return new ProjectAccessContext(
            new ComputerScope(project.computer_id),
            granted,
            new AuditActor(RelayAuditActorKind.Application, row.app_id),
            row.credential_id,
            Date.now(),
            new PerpetualProjectAccessLifetime(),
        );
    };

    /**
     * Authorizes a Session credential the AppCredential issued for `holder`: the AppCredential's own access, while the
     * holder's access to the computer still holds.
     */
    readonly authorizeSessionCredential = async (
        row: CredentialRow,
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const [access, holds] = await Promise.all([
            this.authorize(row, computerId, requiredPermissions, signal),
            this.#storage.holdsAccess(computerId, holder, signal),
        ]);
        if (!holds) {
            throw new ProjectAuthenticationError("credential_revoked", "The Session credential has been revoked");
        }
        return access;
    };

    readonly grants: ProjectCredentialAuthority["grants"] = async (
        computerId,
        credentialId,
        requiredPermissions,
        signal,
    ) =>
        await this.#grantsThrough(
            credentialId,
            async (row) => await this.authorize(row, computerId, requiredPermissions, signal),
            signal,
        );

    readonly grantsSessionCredential: ProjectCredentialAuthority["grantsSessionCredential"] = async (
        computerId,
        credentialId,
        holder,
        requiredPermissions,
        signal,
    ) =>
        await this.#grantsThrough(
            credentialId,
            async (row) => await this.authorizeSessionCredential(row, computerId, requiredPermissions, holder, signal),
            signal,
        );

    /** Whether the AppCredential, while still active, passes `authorize`. */
    readonly #grantsThrough = async (
        credentialId: string,
        authorize: (row: CredentialRow) => Promise<ProjectAccessContext>,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const row = await this.#storage.readCredentialById(credentialId, signal);
        if (row === null || !appCredentialActive(row, Date.now())) {
            return false;
        }
        try {
            await authorize(row);
            return true;
        } catch (cause) {
            if (cause instanceof ProjectAuthenticationError) {
                return false;
            }
            throw cause;
        }
    };
}
