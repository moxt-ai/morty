import type { RuntimeAccessContext } from "../entity/authentication/computer-authentication.ts";
import type { VerifiedComputerAccess } from "../entity/pairing/pairing.ts";
import type { ComputerOnlineStatus } from "../service/computer/computer-status.ts";
export interface ComputerGateway {
    readonly acceptDaemon: (access: RuntimeAccessContext, request: Request, signal: AbortSignal) => Promise<Response>;
    /**
     * Answers a daemon of a revoked Runtime with the revocation close it already handles on a live connection, so it
     * stops for good; a refused handshake would read as a transient failure to retry.
     */
    readonly refuseRevokedDaemon: () => Response;
    readonly acceptHost: (access: VerifiedComputerAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectRuntime: (access: VerifiedComputerAccess, signal: AbortSignal) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedComputerAccess, signal: AbortSignal) => Promise<ComputerOnlineStatus>;
}
