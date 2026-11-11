import type { VerifiedComputerAccess } from "../entity/pairing/pairing.ts";
import type { ComputerStatus } from "../service/computer-relay/computer.ts";
export interface ComputerRelayGateway {
    readonly acceptDaemon: (access: VerifiedComputerAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    /**
     * Answers a daemon of a revoked Computer with the revocation close it already handles on a live connection, so it
     * stops for good; a refused handshake would read as a transient failure to retry.
     */
    readonly refuseRevokedDaemon: () => Response;
    readonly acceptHost: (access: VerifiedComputerAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectComputer: (access: VerifiedComputerAccess, signal: AbortSignal) => Promise<void>;
    readonly readComputerStatus: (access: VerifiedComputerAccess, signal: AbortSignal) => Promise<ComputerStatus>;
}
