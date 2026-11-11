import type { CloudflareComputerRelay } from "../../../../../worker/src/gateway/cloudflare-computer-relay.ts";
import { ComputerSummary } from "../../runtime/service/computer.ts";
import { PairingDirectoryError } from "../entity/pairing.ts";
import { ProjectPermission } from "../entity/project-authentication.ts";
import type { PairingDirectoryService } from "./pairing-directory-service.ts";

export class PairingService {
    readonly #channels: CloudflareComputerRelay;
    readonly #pairings: PairingDirectoryService;

    constructor(cx: {
        readonly services: { readonly pairings: PairingDirectoryService };
        readonly gateways: {
            readonly computerRelayGateway: CloudflareComputerRelay;
        };
    }) {
        this.#channels = cx.gateways.computerRelayGateway;
        this.#pairings = cx.services.pairings;
    }

    readonly createProjectComputerPairing = (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createProjectComputerPairing(computerId, pairingKey, idempotencyKey, signal);

    readonly probeProject = async (computerId: string, signal: AbortSignal): Promise<void> => {
        await this.#pairings.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
    };

    readonly listProjectComputers = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectComputers(computerId, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new ComputerSummary(
                        channel,
                        await this.#channels.readComputerStatus({ computerId: channel.computerId }, signal),
                    ),
            ),
        );
    };

    readonly getComputerAgents = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectComputers(computerId, signal);
        const channel = channels.find((candidate) => candidate.computerId === computerId);
        if (channel === undefined) {
            // A revoked Computer is not listed; saying so lets it be paired again instead of waiting for it.
            if (await this.#pairings.isProjectComputerRevoked(computerId, signal)) {
                throw new PairingDirectoryError("computer_revoked", "The Computer has been revoked");
            }
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        return new ComputerSummary(
            channel,
            await this.#channels.readComputerStatus({ computerId: channel.computerId }, signal),
        );
    };

    readonly readProjectComputerPairing = (computerId: string, signal: AbortSignal) =>
        this.#pairings.readProjectComputerPairing(computerId, signal);

    readonly redeemComputerPairing: PairingDirectoryService["redeemComputerPairing"] = async (
        computerId,
        pairingCode,
        computerName,
        workspaceName,
        agents,
        signal,
    ) =>
        await this.#pairings.redeemComputerPairing(
            computerId,
            pairingCode,
            computerName,
            workspaceName,
            agents,
            signal,
        );

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal) =>
        await this.#pairings.authorizePairedHost(computerId, signal);

    readonly revokeProjectComputer = async (computerId: string, signal: AbortSignal): Promise<void> => {
        const revoked = await this.#pairings.revokeProjectComputer(computerId, signal);
        try {
            await this.#channels.disconnectComputer(revoked.access, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError(
                "computer_disconnect_failed",
                "The Computer was revoked but its active connection could not be closed",
                { cause },
            );
        }
    };
}
