import type { RuntimeAccessContext } from "../entity/authentication/project-authentication.ts";
import type {
    ChannelHostCredential,
    ProjectCredentialHostAccess,
    VerifiedChannelAccess,
} from "../entity/pairing/pairing.ts";
import type { RuntimeStatus } from "../service/channel/channel.ts";
export interface ChannelGateway {
    readonly acceptDaemon: (access: RuntimeAccessContext, request: Request, signal: AbortSignal) => Promise<Response>;
    /**
     * Answers a daemon of a revoked Runtime with the revocation close it already handles on a live connection, so it
     * stops for good; a refused handshake would read as a transient failure to retry.
     */
    readonly refuseRevokedDaemon: () => Response;
    readonly acceptHost: (
        access: ChannelHostCredential | ProjectCredentialHostAccess,
        request: Request,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly disconnectHost: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
    readonly disconnectRuntime: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<void>;
    /** Closes the Runtime's live Session views opened with a Session credential issued no later than `revokedThrough`. */
    readonly disconnectSessionViewers: (
        computerId: string,
        pairingId: string,
        revokedThrough: number,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<RuntimeStatus>;
}
