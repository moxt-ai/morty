import { decodeComputerPlacement } from "../../contracts/computer-id.ts";
import { PairingDirectoryError } from "../../contracts/relay/pairing.ts";
import type { ProjectStorageContext } from "../../contracts/relay/project-storage-context.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

/** The Relay directory is the Project lifecycle authority; it decides whether a Project's storage is served. */
type ActiveProjects = Pick<ComputerManagementStorage, "readActiveComputerScope">;

export class ComputerManagementStorageDirectory {
    readonly #projects: ActiveProjects;

    constructor(projects: ActiveProjects) {
        this.#projects = projects;
    }

    readonly resolve = async (computerId: string, signal: AbortSignal): Promise<ProjectStorageContext | null> => {
        signal.throwIfAborted();
        const placement = decodeComputerPlacement(computerId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        if ((await this.#projects.readActiveComputerScope(computerId, signal)) === null) {
            return null;
        }
        signal.throwIfAborted();
        return {
            computerId,
        };
    };
}
