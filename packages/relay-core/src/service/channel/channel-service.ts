import type { RuntimeAccessContext } from "../../entity/authentication/project-authentication.ts";
import type { AgentDescriptor } from "../../entity/pairing/pairing.ts";
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
        channelId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.updateAgentCatalog(channelId, token, successor, agents, signal);

    readonly createAccessGrant = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.createChannelAccessGrant(channelId, token, signal);

    readonly redeemAccessGrant = (channelId: string, grantId: string, grantSecret: string, signal: AbortSignal) =>
        this.#pairings.redeemChannelAccessGrant(channelId, grantId, grantSecret, signal);

    readonly listLinkedDevices = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.listLinkedChannelDevices(channelId, token, signal);

    readonly revokeLinkedDevice = async (
        channelId: string,
        credentialId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const credential = await this.#pairings.revokeLinkedChannelDevice(channelId, credentialId, token, signal);
        await this.#channelGateway.disconnectHost(credential, signal);
    };

    readonly readChannel = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.readChannel(channelId, token, signal);

    readonly authorizeHost = (channelId: string, token: string, signal: AbortSignal) =>
        this.#pairings.authorizeHost(channelId, token, signal);

    /**
     * Authorizes a daemon connection, rotating its credential. A reused credential ends the Runtime's access first; a
     * daemon of a Runtime whose access ended is told so, so it stops instead of retrying.
     */
    readonly connectRuntime = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "accepted"; readonly access: RuntimeAccessContext } | { readonly kind: "revoked" }> => {
        const rotation = await this.#pairings.rotateRuntimeCredential(token, successor, signal);
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
                event: "runtime_credential_reused",
                projectId: rotation.access.projectId,
                runtimeId: rotation.access.runtimeId,
            },
            "A retired Runtime credential was presented; the Runtime was revoked",
        );
        await this.#channelGateway.disconnectRuntime(rotation.access, signal);
        return { kind: "revoked" };
    };
}
