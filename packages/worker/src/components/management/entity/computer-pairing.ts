import { PairingDirectoryError } from "@morty-build/relay-core/contracts";

/**
 * Where a computer's Runtime pairing stands, read from the Relay that owns it. A pending or expired pairing request
 * leaves the computer unpaired; a revoked Computer stays revoked until the computer is paired again.
 */
export type ComputerPairing = "unpaired" | "paired" | "revoked";

/** The refusal of an operation on a computer whose Computer the Relay revoked. */
export function computerRevoked(): PairingDirectoryError {
    return new PairingDirectoryError("computer_revoked", "The Computer has been revoked");
}
