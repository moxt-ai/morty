import type { RuntimeAccessContext } from "../../entity/authentication/computer-authentication.ts";
import type { AgentDescriptor } from "../../entity/pairing/pairing.ts";
import type { ComputerGateway } from "../../gateway/index.ts";
import { logger } from "../../infra/logger.ts";
import type { PairingOperations } from "../pairing/pairing-operations.ts";
export class ComputerCatalogService {
    readonly #pairings: PairingOperations;
    readonly #computerGateway: ComputerGateway;
    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly computerGateway: ComputerGateway;
        };
    }) {
        const { computerGateway } = cx.gateways;
        this.#pairings = cx.services.pairings;
        this.#computerGateway = computerGateway;
    }
    readonly updateAgentCatalog = (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.updateAgentCatalog(computerId, token, successor, agents, signal);

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
                computerId: rotation.access.computerId,
            },
            "A retired Runtime credential was presented; the Runtime was revoked",
        );
        await this.#computerGateway.disconnectRuntime(rotation.access, signal);
        return { kind: "revoked" };
    };
}
