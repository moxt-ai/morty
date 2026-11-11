import { PairingDirectoryError } from "@morty-build/relay-core/contracts";

/**
 * Where a computer's Runtime pairing stands, read from the Relay that owns it. A pending or expired pairing request
 * leaves the computer unpaired; a revoked Runtime stays revoked until the computer is paired again.
 */
export type RuntimePairing = "unpaired" | "paired" | "revoked";

/** The refusal of an operation on a computer whose Runtime the Relay revoked. */
export function runtimeRevoked(): PairingDirectoryError {
    return new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
}
