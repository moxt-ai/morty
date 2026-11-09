import type { ProjectStorageDirectory } from "@morty-build/relay-core/contracts";
import { PairingDirectoryError } from "@morty-build/relay-core/contracts";
import { decodeAccountPlacement, projectBucketLocation } from "../entity/machine-account-id.ts";
import type { PlatformProjectPlacementRegistry } from "../entity/platform-control-plane.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

/** The Platform directory is the Project lifecycle authority; it decides whether a Project's storage is served. */
type ActiveProjects = Pick<PlatformControlPlaneStorage, "readActiveAccountScope">;

export class PlatformProjectStorageDirectory implements ProjectStorageDirectory {
    readonly #registry: PlatformProjectPlacementRegistry;
    readonly #projects: ActiveProjects;

    constructor(registry: PlatformProjectPlacementRegistry, projects: ActiveProjects) {
        this.#registry = registry;
        this.#projects = projects;
    }

    readonly resolve: ProjectStorageDirectory["resolve"] = async (accountId, signal) => {
        signal.throwIfAborted();
        const placement = decodeAccountPlacement(accountId);
        if (placement === null || !this.#registry.supports(placement)) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        if ((await this.#projects.readActiveAccountScope(accountId, signal)) === null) {
            return null;
        }
        signal.throwIfAborted();
        return {
            accountId,
            storagePlacement: {
                hasShard: true,
                shard: {
                    d1ShardId: accountId,
                    r2BucketId: projectBucketLocation(placement.locationHint),
                    revision: 1,
                },
            },
        };
    };
}
