import type { ProjectStorageDirectory } from "@morty-build/relay-core/contracts";
import { PairingDirectoryError } from "@morty-build/relay-core/contracts";
import { decodeComputerPlacement, projectBucketLocation } from "../entity/computer-id.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

/** The Relay directory is the Project lifecycle authority; it decides whether a Project's storage is served. */
type ActiveProjects = Pick<ComputerManagementStorage, "readActiveComputerScope">;

export class ComputerManagementStorageDirectory implements ProjectStorageDirectory {
    readonly #projects: ActiveProjects;

    constructor(projects: ActiveProjects) {
        this.#projects = projects;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (computerId, signal) => {
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
            storagePlacement: {
                hasShard: true,
                shard: {
                    d1ShardId: computerId,
                    r2BucketId: projectBucketLocation(placement.locationHint),
                    revision: 1,
                },
            },
        };
    };
}
