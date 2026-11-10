import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    NativeSessionTarget,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { hashSecret, type RelayContext, SessionControl } from "@morty-build/relay-core";
import type { RuntimeControlCommand } from "../../../relay-core/src/service/pairing/runtime-control-request.ts";
import type { SessionAccessService } from "./session-access-service.ts";

/** Internal operations colocated with this computer's storage and Runtime connection. Never an HTTP router. */
export class ComputerBackendService {
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
        await this.context.services.runtimePairings.createProjectRuntimePairing(
            this.computerId,
            await this.#pairingKey(),
            idempotencyKey,
            signal,
        );
    readonly readPairing = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.readProjectRuntimePairing(this.computerId, signal);
    readonly revokeRuntime = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.revokeProjectRuntime(this.computerId, signal);
    readonly runtimes = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.listProjectRuntimes(this.computerId, signal);
    readonly agents = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.getRuntimeAgents(this.computerId, signal);
    readonly diagnostics = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.readRuntimeDiagnostics(this.computerId, signal);
    readonly latency = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.measureRuntimeLatency(this.computerId, signal);
    readonly probe = async (signal: AbortSignal) =>
        await this.context.services.runtimePairings.probeProject(this.computerId, signal);
    readonly control = async (command: RuntimeControlCommand, signal: AbortSignal) =>
        await this.context.services.runtimePairings.requestControl(this.computerId, command, signal);
    readonly workspace = async (command: WorkspaceListCommand, signal: AbortSignal) =>
        await this.context.services.runtimePairings.listWorkspace(this.computerId, command, signal);
    readonly settings = async (command: AgentSettingsDiscoverCommand, signal: AbortSignal) =>
        await this.context.services.runtimePairings.discoverAgentSettings(this.computerId, command, signal);
    readonly fork = async (operationId: string, input: ForkMortyNativeSessionRequest, signal: AbortSignal) =>
        await this.context.services.runtimePairings.forkNativeSession(this.computerId, operationId, input, signal);
    readonly session = (target: NativeSessionTarget, signal: AbortSignal) =>
        new SessionControl(
            async (command, permission) =>
                await this.context.services.runtimePairings.requestOperationControl(
                    this.computerId,
                    command,
                    permission,
                    signal,
                ),
            target,
        );
    readonly issueSessionAccess = async (target: NativeSessionTarget, lifetime: number, signal: AbortSignal) =>
        await this.sessionAccess.issue({ kind: "session", computerId: this.computerId, target }, lifetime, signal);
    readonly revokeSessionAccess = async (signal: AbortSignal) =>
        await this.sessionAccess.revoke(
            this.computerId,
            { disconnect: this.context.gateways.channelGateway.disconnectSessionViewers },
            signal,
        );
    readonly openHost = async (signal: AbortSignal): Promise<WebSocket> => {
        const access = await this.context.services.runtimePairings.authorizePairedHost(this.computerId, signal);
        const response = await this.context.gateways.channelGateway.acceptHost(
            access,
            new Request("https://runtime.internal/host", { headers: { upgrade: "websocket" }, signal }),
            signal,
        );
        if (response.status !== 101 || response.webSocket === null) {
            throw new Error("Runtime host connection was not accepted");
        }
        return response.webSocket;
    };
}
