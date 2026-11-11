import type { AgentDescriptor, VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/index.ts";
import { logger } from "../../infra/logger.ts";
import type { PairingOperations } from "../pairing/pairing-operations.ts";
export class ChannelService {
    readonly #pairings: PairingOperations;
    readonly #channelGateway: ChannelGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
        };
    }) {
        const { channelGateway } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#channelGateway = channelGateway;
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
        { readonly kind: "accepted"; readonly access: VerifiedChannelAccess } | { readonly kind: "revoked" }
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
        await this.#channelGateway.disconnectComputer(rotation.access, signal);
        return { kind: "revoked" };
    };
}
