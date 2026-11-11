import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import {
    type AgentSettingsDiscoverCommand,
    decodeRuntimeDiagnosticsRequest,
    type WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../management/entity/pairing.ts";
import { ProjectPermission } from "../../management/entity/project-authentication.ts";
import type { PairingDirectoryService } from "../../management/service/pairing-directory-service.ts";
import type { LocalSessionOperations } from "./local-session-operations.ts";
import { runtimeControlPermission } from "./runtime-control-registry.ts";
import type { RuntimeControlCommand } from "./runtime-control-request.ts";

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

    readonly requestControl = async (computerId: string, command: RuntimeControlCommand, signal: AbortSignal) =>
        await this.requestOperationControl(computerId, command, runtimeControlPermission(command), signal);

    readonly requestOperationControl = async (
        computerId: string,
        command: RuntimeControlCommand,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.pairings.authorizeProject(computerId, permission, signal);
        return await this.operations.requestComputerScopeControl(access.scope, command, signal);
    };

    readonly readRuntimeDiagnostics = async (computerId: string, signal: AbortSignal) => {
        const command = decodeRuntimeDiagnosticsRequest(
            JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        return await this.requestControl(computerId, command, signal);
    };

    readonly measureRuntimeLatency = async (computerId: string, signal: AbortSignal): Promise<number> => {
        const command: RuntimeControlCommand = { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.pairings.authorizeProject(computerId, runtimeControlPermission(command), signal);
        const started = performance.now();
        await this.operations.requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (computerId: string, command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.pairings.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        return await this.operations.requestWorkspace(access.scope, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.pairings.listProjectRuntimes(computerId, signal);
        if (!runtimes.some((candidate) => candidate.computerId === computerId)) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        const access = await this.pairings.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        return await this.operations.requestAgentSettings(access.scope, command, signal);
    };
}
