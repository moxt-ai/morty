import type { ComputerStorageDirectory } from "@morty-build/relay-core/contracts";
import { PairingDirectoryError } from "@morty-build/relay-core/contracts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";

/** The Relay directory is the Computer lifecycle authority; it decides whether a Computer's storage is served. */
type ActiveComputers = Pick<ComputerManagementStorage, "readActiveComputerScope">;

export class ComputerManagementStorageDirectory implements ComputerStorageDirectory {
    readonly #computers: ActiveComputers;

    constructor(computers: ActiveComputers) {
        this.#computers = computers;
    }

    readonly resolve: ComputerStorageDirectory["resolve"] = async (computerId, signal) => {
        signal.throwIfAborted();
        const placement = decodeComputerPlacement(computerId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Computer storage placement is unavailable");
        }
        if ((await this.#computers.readActiveComputerScope(computerId, signal)) === null) {
            return null;
        }
        signal.throwIfAborted();
        return {
            computerId,
        };
    };
}
