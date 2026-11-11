import { RELAY_APP_PROJECT_PERMISSIONS, type SessionAccessHolder } from "@morty-build/client/protocol";
import {
    AuditActor,
    ComputerScope,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectCredentialAuthority,
    ProjectPermission,
} from "@morty-build/relay-core";
import { RelayAuditActorKind } from "../entity/computer-management.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

const permissions = new Set(RELAY_APP_PROJECT_PERMISSIONS.map(ProjectPermission.named));

/** Rechecks account lifecycle and session revocation at the execution boundary, including live connections. */
export class BackendProjectAccess implements ProjectCredentialAuthority {
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.storage = storage;
    }

    readonly authorize = async (
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.storage.readActiveComputerScope(computerId, signal);
        if (project === null) {
            throw new ProjectAuthenticationError("project_access_denied", "The computer is unavailable");
        }
        if (!requiredPermissions.every((permission) => permissions.has(permission))) {
            throw new ProjectAuthenticationError("project_permission_denied", "The operation is not permitted");
        }
        return new ProjectAccessContext(
            new ComputerScope(project.computer_id),
            permissions,
            new AuditActor(RelayAuditActorKind.Application, project.user_id),
        );
    };

    readonly authorizeSession = async (
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const [access, holdsAccess] = await Promise.all([
            this.authorize(computerId, requiredPermissions, signal),
            this.storage.holdsAccess(computerId, holder, signal),
        ]);
        if (!holdsAccess) {
            throw new ProjectAuthenticationError("credential_revoked", "The Session credential has been revoked");
        }
        return access;
    };

    readonly grants: ProjectCredentialAuthority["grants"] = async (computerId, required, signal) =>
        await this.#granted(() => this.authorize(computerId, required, signal));

    readonly grantsSessionCredential: ProjectCredentialAuthority["grantsSessionCredential"] = async (
        computerId,
        holder,
        required,
        signal,
    ) => await this.#granted(() => this.authorizeSession(computerId, required, holder, signal));

    readonly #granted = async (authorize: () => Promise<ProjectAccessContext>): Promise<boolean> => {
        try {
            await authorize();
            return true;
        } catch (cause) {
            if (cause instanceof ProjectAuthenticationError) {
                return false;
            }
            throw cause;
        }
    };
}
