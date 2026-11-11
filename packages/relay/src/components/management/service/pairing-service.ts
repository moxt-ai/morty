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

    readonly createProjectRuntimePairing = (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createProjectRuntimePairing(computerId, pairingKey, idempotencyKey, signal);

    readonly probeProject = async (computerId: string, signal: AbortSignal): Promise<void> => {
        await this.#pairings.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
    };

    readonly listProjectRuntimes = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(computerId, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new ComputerSummary(
                        channel,
                        await this.#channels.readRuntimeStatus({ computerId: channel.computerId }, signal),
                    ),
            ),
        );
    };

    readonly getRuntimeAgents = async (computerId: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(computerId, signal);
        const channel = channels.find((candidate) => candidate.computerId === computerId);
        if (channel === undefined) {
            // A revoked Runtime is not listed; saying so lets its Machine be paired again instead of waiting for it.
            if (await this.#pairings.isProjectRuntimeRevoked(computerId, signal)) {
                throw new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
            }
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        return new ComputerSummary(
            channel,
            await this.#channels.readRuntimeStatus({ computerId: channel.computerId }, signal),
        );
    };

    readonly readProjectRuntimePairing = (computerId: string, signal: AbortSignal) =>
        this.#pairings.readProjectRuntimePairing(computerId, signal);

    readonly redeemRuntimePairing: PairingDirectoryService["redeemRuntimePairing"] = async (
        computerId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) => await this.#pairings.redeemRuntimePairing(computerId, pairingCode, machineName, workspaceName, agents, signal);

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal) =>
        await this.#pairings.authorizePairedHost(computerId, signal);

    readonly revokeProjectRuntime = async (computerId: string, signal: AbortSignal): Promise<void> => {
        const revoked = await this.#pairings.revokeProjectRuntime(computerId, signal);
        try {
            await this.#channels.disconnectRuntime(revoked.access, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError(
                "runtime_disconnect_failed",
                "The Runtime was revoked but its active connection could not be closed",
                { cause },
            );
        }
    };
}
