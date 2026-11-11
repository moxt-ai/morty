import {
    RELAY_APP_PROJECT_PERMISSIONS,
    type SessionAccessGrant,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { ComputerScope } from "../../runtime/entity/session.ts";
import {
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectPermission,
} from "../entity/project-authentication.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

const permissions = new Set(RELAY_APP_PROJECT_PERMISSIONS);

/** Rechecks account lifecycle and session revocation at the execution boundary, including live connections. */
export class BackendProjectAccess {
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
        return new ProjectAccessContext(new ComputerScope(project.computer_id), permissions, {
            kind: "application",
            actorId: project.user_id,
        });
    };

    readonly authorizeSession = async (
        computerId: string,
        requiredPermissions: readonly ProjectPermission[],
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const [access, generation] = await Promise.all([
            this.authorize(computerId, requiredPermissions, signal),
            this.currentSessionGeneration(computerId, grant.holder, signal),
        ]);
        if (generation !== grant.generation) {
            throw new ProjectAuthenticationError("credential_revoked", "The Session credential has been revoked");
        }
        return access;
    };

    /** Resolves current authority without storing another copy of pairing state. */
    readonly currentSessionGeneration = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<number | null> => {
        const [holds, generation] = await Promise.all([
            this.storage.holdsAccess(computerId, holder, signal),
            this.storage.projects.forProject(computerId).readActiveGeneration(computerId, signal),
        ]);
        return holds ? generation : null;
    };

    readonly grants = async (
        computerId: string,
        required: readonly ProjectPermission[],
        signal: AbortSignal,
    ): Promise<boolean> => await this.#granted(() => this.authorize(computerId, required, signal));

    readonly grantsSessionCredential = async (
        computerId: string,
        grant: SessionAccessGrant,
        required: readonly ProjectPermission[],
        signal: AbortSignal,
    ): Promise<boolean> => await this.#granted(() => this.authorizeSession(computerId, required, grant, signal));

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
