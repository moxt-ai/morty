import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    NativeSessionTarget,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import type { RelayContext } from "../../../composition/create-relay-dependencies.ts";
import type { ComputerControlCommand } from "../../runtime/service/computer-control-request.ts";
import type { RuntimeOperationsService } from "../../runtime/service/runtime-operations-service.ts";
import type { SessionAccessService } from "../../runtime/service/session-access-service.ts";
import { SessionControl } from "../../runtime/service/session-control.ts";
import { ComputerManagementBackendService } from "./computer-management-backend-service.ts";

/** Only constructed inside the ComputerRelay that owns these Computer operations. */
export class ComputerBackendService extends ComputerManagementBackendService {
    private readonly operations: RuntimeOperationsService;
    constructor(
        computerId: string,
        context: RelayContext,
        sessionAccess: SessionAccessService,
        pairingRoot: string,
        operations: RuntimeOperationsService,
    ) {
        super(computerId, context, sessionAccess, pairingRoot);
        this.operations = operations;
    }

    readonly diagnostics = async (signal: AbortSignal) =>
        await this.operations.readComputerDiagnostics(this.computerId, signal);
    readonly latency = async (signal: AbortSignal) =>
        await this.operations.measureComputerLatency(this.computerId, signal);
    readonly control = async (command: ComputerControlCommand, signal: AbortSignal) =>
        await this.operations.requestControl(this.computerId, command, signal);
    readonly workspace = async (command: WorkspaceListCommand, signal: AbortSignal) =>
        await this.operations.listWorkspace(this.computerId, command, signal);
    readonly settings = async (command: AgentSettingsDiscoverCommand, signal: AbortSignal) =>
        await this.operations.discoverAgentSettings(this.computerId, command, signal);
    readonly fork = async (operationId: string, input: ForkMortyNativeSessionRequest, signal: AbortSignal) =>
        await this.operations.forkNativeSession(this.computerId, operationId, input, signal);
    readonly session = (target: NativeSessionTarget, signal: AbortSignal) =>
        new SessionControl(
            async (command) => await this.operations.requestControl(this.computerId, command, signal),
            target,
        );
}
