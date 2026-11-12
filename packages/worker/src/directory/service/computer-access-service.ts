import type { SessionAccessGrant, SessionAccessHolder } from "@morty-build/client/protocol";
import { type ComputerAccess, ProjectAuthenticationError } from "../../contracts/relay/project-authentication.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

/** Rechecks account lifecycle and session revocation at the execution boundary, including live connections. */
export class ComputerAccessService {
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.storage = storage;
    }

    readonly authorize = async (computerId: string, signal: AbortSignal): Promise<ComputerAccess> => {
        const project = await this.storage.readActiveComputerScope(computerId, signal);
        if (project === null) {
            throw new ProjectAuthenticationError("project_access_denied", "The computer is unavailable");
        }
        return { computerId: project.computer_id };
    };

    readonly authorizeSession = async (
        computerId: string,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<ComputerAccess> => {
        const [access, generation] = await Promise.all([
            this.authorize(computerId, signal),
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

    readonly grantsSessionCredential = async (
        computerId: string,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ): Promise<boolean> => await this.#granted(() => this.authorizeSession(computerId, grant, signal));

    readonly #granted = async (authorize: () => Promise<ComputerAccess>): Promise<boolean> => {
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
