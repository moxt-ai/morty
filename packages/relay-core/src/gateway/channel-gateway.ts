import type { RuntimeAccessContext } from "../entity/authentication/project-authentication.ts";
import type { VerifiedChannelAccess } from "../entity/pairing/pairing.ts";
import type { RuntimeStatus } from "../service/channel/channel.ts";
export interface ChannelGateway {
    readonly acceptDaemon: (access: RuntimeAccessContext, request: Request, signal: AbortSignal) => Promise<Response>;
    /**
     * Answers a daemon of a revoked Runtime with the revocation close it already handles on a live connection, so it
     * stops for good; a refused handshake would read as a transient failure to retry.
     */
    readonly refuseRevokedDaemon: () => Response;
    readonly acceptHost: (access: VerifiedChannelAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectRuntime: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<RuntimeStatus>;
}
