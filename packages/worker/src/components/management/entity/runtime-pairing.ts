import { ComputerManagementError } from "./computer-management.ts";

/**
 * Where a computer's Runtime pairing stands, read from the Relay that owns it. A pending or expired pairing request
 * leaves the computer unpaired; a revoked Runtime stays revoked until the computer is paired again.
 */
export type RuntimePairing = "unpaired" | "paired" | "revoked";

/** The refusal of an operation on a computer whose Runtime the Relay revoked. */
export function runtimeRevoked(options?: ErrorOptions): ComputerManagementError {
    return new ComputerManagementError(
        "RUNTIME_REVOKED",
        "This computer was disconnected because its connection key was used somewhere else. Run Morty setup on it again to reconnect.",
        410,
        options,
    );
}
