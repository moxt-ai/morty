import type { CloudflareComputerRelay } from "../../../../../worker/src/gateway/cloudflare-computer-relay.ts";
import { logger } from "../../../infra/logger.ts";
import type { AgentDescriptor, VerifiedComputerAccess } from "../entity/pairing.ts";
import type { PairingDirectoryService } from "./pairing-directory-service.ts";

export class ComputerConnectionService {
    readonly #pairings: PairingDirectoryService;
    readonly #computerRelayGateway: CloudflareComputerRelay;
    constructor(cx: {
        readonly services: { readonly pairings: PairingDirectoryService };
        readonly gateways: {
            readonly computerRelayGateway: CloudflareComputerRelay;
        };
    }) {
        const { computerRelayGateway } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#computerRelayGateway = computerRelayGateway;
    }
    readonly updateAgentCatalog = (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.updateAgentCatalog(computerId, token, successor, agents, signal);

    /**
     * Authorizes a daemon connection, rotating its credential. A reused credential ends the Computer's access first; a
     * daemon of a Computer whose access ended is told so, so it stops instead of retrying.
     */
    readonly connectComputer = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "accepted"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
        const rotation = await this.#pairings.rotateComputerCredential(token, successor, signal);
        switch (rotation.kind) {
            case "rotated":
                return { kind: "accepted", access: rotation.access };
            case "revoked":
                return rotation;
            case "reused":
                break;
        }
        logger.warn(
            {
                event: "computer_credential_reused",
                computerId: rotation.access.computerId,
            },
            "A retired Computer credential was presented; the Computer was revoked",
        );
        await this.#computerRelayGateway.disconnectComputer(rotation.access, signal);
        return { kind: "revoked" };
    };
}
