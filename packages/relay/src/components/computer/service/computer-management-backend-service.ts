import type { NativeSessionTarget, SessionAccessHolder } from "@morty-build/client/protocol";
import type { RelayContext } from "../../../composition/create-relay-dependencies.ts";
import { hashSecret } from "../../management/entity/pairing.ts";
import type { SessionAccessService } from "../../runtime/service/session-access-service.ts";

/** Internal operations colocated with this computer's storage and Computer connection. Never an HTTP router. */
export class ComputerManagementBackendService {
    readonly computerId: string;
    readonly context: RelayContext;
    readonly sessionAccess: SessionAccessService;
    readonly pairingRoot: string;
    constructor(computerId: string, context: RelayContext, sessionAccess: SessionAccessService, pairingRoot: string) {
        this.computerId = computerId;
        this.context = context;
        this.sessionAccess = sessionAccess;
        this.pairingRoot = pairingRoot;
    }

    // Pairing retries derive the same code without storing or transporting a service credential.
    readonly #pairingKey = () => hashSecret(`morty.internal.pairing.v1:${this.pairingRoot}`);

    readonly createPairing = async (idempotencyKey: string, signal: AbortSignal) =>
        await this.context.services.computerPairings.createProjectComputerPairing(
            this.computerId,
            await this.#pairingKey(),
            idempotencyKey,
            signal,
        );
    readonly readPairing = async (signal: AbortSignal) =>
        await this.context.services.computerPairings.readProjectComputerPairing(this.computerId, signal);
    readonly revokeComputer = async (signal: AbortSignal) =>
        await this.context.services.computerPairings.revokeProjectComputer(this.computerId, signal);
    readonly computers = async (signal: AbortSignal) =>
        await this.context.services.computerPairings.listProjectComputers(this.computerId, signal);
    readonly agents = async (signal: AbortSignal) =>
        await this.context.services.computerPairings.getComputerAgents(this.computerId, signal);
    readonly probe = async (signal: AbortSignal) =>
        await this.context.services.computerPairings.probeProject(this.computerId, signal);
    readonly issueSessionAccess = async (
        target: NativeSessionTarget,
        lifetime: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ) =>
        await this.sessionAccess.issue(
            { kind: "session", computerId: this.computerId, target },
            lifetime,
            holder,
            signal,
        );
    readonly openHost = async (signal: AbortSignal): Promise<WebSocket> => {
        const access = await this.context.services.computerPairings.authorizePairedHost(this.computerId, signal);
        const response = await this.context.gateways.computerRelayGateway.acceptHost(
            access,
            new Request("https://computer-relay.internal/host", { headers: { upgrade: "websocket" }, signal }),
            signal,
        );
        if (response.status !== 101 || response.webSocket === null) {
            throw new Error("Computer host connection was not accepted");
        }
        return response.webSocket;
    };
}
