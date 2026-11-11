const computerRevocationCloseCode = 1008;
const computerRevocationCloseReason = "Computer revoked";

/**
 * A Computer relay revocation is terminal for this local Computer.  It is normalized from the
 * deployed Relay close record so callers never need to branch on transport text.
 */
export class ComputerRelayRevokedError extends Error {
    readonly code = "computer_relay_revoked";
    readonly closeCode: number;
    readonly closeReason: string;

    constructor(closeCode: number, closeReason: string, options: ErrorOptions = {}) {
        super("The Computer was revoked by the Relay", options);
        this.closeCode = closeCode;
        this.closeReason = closeReason;
        this.name = "ComputerRelayRevokedError";
    }
}

export function isComputerRelayRevocation(closeCode: number, closeReason: string): boolean {
    return closeCode === computerRevocationCloseCode && closeReason === computerRevocationCloseReason;
}
