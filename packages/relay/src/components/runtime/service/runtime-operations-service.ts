import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import {
    type AgentSettingsDiscoverCommand,
    decodeComputerDiagnosticsRequest,
    type WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../management/entity/pairing.ts";
import { ProjectPermission } from "../../management/entity/project-authentication.ts";
import type { PairingDirectoryService } from "../../management/service/pairing-directory-service.ts";
import { computerControlPermission } from "./computer-control-registry.ts";
import type { ComputerControlCommand } from "./computer-control-request.ts";
import type { LocalSessionOperations } from "./local-session-operations.ts";

/** Authorized operations owned by the ComputerRelay holding the daemon connection. */
export class RuntimeOperationsService {
    private readonly pairings: PairingDirectoryService;
    private readonly operations: LocalSessionOperations;
    constructor(pairings: PairingDirectoryService, operations: LocalSessionOperations) {
        this.pairings = pairings;
        this.operations = operations;
    }

    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const access = await this.pairings.authorizeProject(computerId, ProjectPermission.SessionWrite, signal);
        return await this.operations.forkNativeSession(access.scope, operationId, input, signal);
    };

    readonly requestControl = async (computerId: string, command: ComputerControlCommand, signal: AbortSignal) =>
        await this.requestOperationControl(computerId, command, computerControlPermission(command), signal);

    readonly requestOperationControl = async (
        computerId: string,
        command: ComputerControlCommand,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.pairings.authorizeProject(computerId, permission, signal);
        return await this.operations.requestComputerScopeControl(access.scope, command, signal);
    };

    readonly readComputerDiagnostics = async (computerId: string, signal: AbortSignal) => {
        const command = decodeComputerDiagnosticsRequest(
            JSON.stringify({ kind: "computer.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        return await this.requestControl(computerId, command, signal);
    };

    readonly measureComputerLatency = async (computerId: string, signal: AbortSignal): Promise<number> => {
        const command: ComputerControlCommand = { kind: "computer.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.pairings.authorizeProject(computerId, computerControlPermission(command), signal);
        const started = performance.now();
        await this.operations.requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (computerId: string, command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.pairings.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        return await this.operations.requestWorkspace(access.scope, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.pairings.listProjectComputers(computerId, signal);
        if (!runtimes.some((candidate) => candidate.computerId === computerId)) {
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        const access = await this.pairings.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        return await this.operations.requestAgentSettings(access.scope, command, signal);
    };
}
