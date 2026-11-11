import {
    RELAY_COMPUTER_PERMISSIONS,
    type SessionAccessGrant,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import {
    AuditActor,
    ComputerAccessContext,
    ComputerAuthenticationError,
    type ComputerCredentialAuthority,
    ComputerPermission,
    ComputerScope,
} from "@morty-build/relay-core";
import { RelayAuditActorKind } from "../entity/computer-management.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

const permissions = new Set(RELAY_COMPUTER_PERMISSIONS.map(ComputerPermission.named));

/** Rechecks account lifecycle and session revocation at the execution boundary, including live connections. */
export class BackendComputerAccess implements ComputerCredentialAuthority {
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.storage = storage;
    }

    readonly authorize = async (
        computerId: string,
        requiredPermissions: readonly ComputerPermission[],
        signal: AbortSignal,
    ): Promise<ComputerAccessContext> => {
        const computer = await this.storage.readActiveComputerScope(computerId, signal);
        if (computer === null) {
            throw new ComputerAuthenticationError("project_access_denied", "The computer is unavailable");
        }
        if (!requiredPermissions.every((permission) => permissions.has(permission))) {
            throw new ComputerAuthenticationError("project_permission_denied", "The operation is not permitted");
        }
        return new ComputerAccessContext(
            new ComputerScope(computer.computer_id),
            permissions,
            new AuditActor(RelayAuditActorKind.Application, computer.user_id),
        );
    };

    readonly authorizeSession = async (
        computerId: string,
        requiredPermissions: readonly ComputerPermission[],
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<ComputerAccessContext> => {
        const [access, generation] = await Promise.all([
            this.authorize(computerId, requiredPermissions, signal),
            this.currentSessionGeneration(computerId, grant.holder, signal),
        ]);
        if (generation !== grant.generation) {
            throw new ComputerAuthenticationError("credential_revoked", "The Session credential has been revoked");
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
            this.storage.computers.forComputer(computerId).readActiveGeneration(computerId, signal),
        ]);
        return holds ? generation : null;
    };

    readonly grants: ComputerCredentialAuthority["grants"] = async (computerId, required, signal) =>
        await this.#granted(() => this.authorize(computerId, required, signal));

    readonly grantsSessionCredential: ComputerCredentialAuthority["grantsSessionCredential"] = async (
        computerId,
        grant,
        required,
        signal,
    ) => await this.#granted(() => this.authorizeSession(computerId, required, grant, signal));

    readonly #granted = async (authorize: () => Promise<ComputerAccessContext>): Promise<boolean> => {
        try {
            await authorize();
            return true;
        } catch (cause) {
            if (cause instanceof ComputerAuthenticationError) {
                return false;
            }
            throw cause;
        }
    };
}
