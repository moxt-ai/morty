import { isProjectLocationHint } from "@morty-build/client/protocol";
import { projectBucketLocation } from "../entity/computer-id.ts";
import type {
    ComputerManagementPlacement,
    ComputerManagementPlacementRegistry,
} from "../entity/computer-management.ts";

export interface RelayStorageBindings {
    readonly R2_BUCKET_WNAM?: R2Bucket;
    readonly R2_BUCKET_APAC?: R2Bucket;
}

function relayBucket(bindings: RelayStorageBindings, id: string): R2Bucket | undefined {
    return id === "apac" ? bindings.R2_BUCKET_APAC : id === "wnam" ? bindings.R2_BUCKET_WNAM : undefined;
}

export class RelayStorageRegistry implements ComputerManagementPlacementRegistry {
    readonly #bindings: RelayStorageBindings;

    constructor(bindings: RelayStorageBindings) {
        this.#bindings = bindings;
    }

    readonly supports = (placement: ComputerManagementPlacement): boolean =>
        relayBucket(this.#bindings, projectBucketLocation(placement.locationHint)) !== undefined;

    readonly resolveLocationHint = (locationHint: string): ComputerManagementPlacement | null =>
        isProjectLocationHint(locationHint) &&
        relayBucket(this.#bindings, projectBucketLocation(locationHint)) !== undefined
            ? { locationHint }
            : null;
}
