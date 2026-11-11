import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type { AgentSettingsDiscoverCommand, WorkspaceListCommand } from "@morty-build/client/protocol";
import { decodeComputerDiagnosticsRequest } from "@morty-build/client/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { ComputerRelayGateway } from "../../gateway/computer-relay-gateway.ts";
import { ComputerSummary } from "../computer-relay/computer.ts";
import type { LocalSessionOperations } from "../computer-relay/local-session-operations.ts";
import { computerControlPermission } from "./computer-control-registry.ts";
import type { ComputerControlCommand } from "./computer-control-request.ts";
import type { PairingOperations } from "./pairing-operations.ts";

export class PairingService {
    readonly #relay: ComputerRelayGateway;
    readonly #pairings: PairingOperations;
    // Computer operations execute only in the ComputerRelay that holds the daemon connection; every Computer route reaches it there.
    readonly #runtimeOperations: LocalSessionOperations | undefined;

    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly computerRelayGateway: ComputerRelayGateway;
            readonly runtimeOperations?: LocalSessionOperations;
        };
    }) {
        this.#relay = cx.gateways.computerRelayGateway;
        this.#runtimeOperations = cx.gateways.runtimeOperations;
        this.#pairings = cx.services.pairings;
    }

    readonly #operations = (): LocalSessionOperations => {
        if (this.#runtimeOperations === undefined) {
            throw new Error("Computer operations run only in the ComputerRelay");
        }
        return this.#runtimeOperations;
    };

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
        const computers = await this.#pairings.listProjectComputers(computerId, signal);
        return await Promise.all(
            computers.map(
                async (computer) =>
                    new ComputerSummary(
                        computer,
                        await this.#relay.readComputerStatus({ computerId: computer.computerId }, signal),
                    ),
            ),
        );
    };

    readonly getComputerAgents = async (computerId: string, signal: AbortSignal) => {
        const computers = await this.#pairings.listProjectComputers(computerId, signal);
        const computer = computers.find((candidate) => candidate.computerId === computerId);
        if (computer === undefined) {
            // A revoked Computer is not listed; saying so lets its Machine be paired again instead of waiting for it.
            if (await this.#pairings.isProjectComputerRevoked(computerId, signal)) {
                throw new PairingDirectoryError("computer_revoked", "The Computer has been revoked");
            }
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        return new ComputerSummary(
            computer,
            await this.#relay.readComputerStatus({ computerId: computer.computerId }, signal),
        );
    };

    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, ProjectPermission.SessionWrite, signal);
        return await this.#operations().forkNativeSession(access.scope, operationId, input, signal);
    };

    readonly requestControl = async (computerId: string, command: ComputerControlCommand, signal: AbortSignal) =>
        await this.requestOperationControl(computerId, command, computerControlPermission(command), signal);

    /** Runs one command of an operation that needs `permission`, which may be the operation's rather than the command's. */
    readonly requestOperationControl = async (
        computerId: string,
        command: ComputerControlCommand,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, permission, signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly readComputerDiagnostics = async (computerId: string, signal: AbortSignal) => {
        const command = decodeComputerDiagnosticsRequest(
            JSON.stringify({ kind: "computer.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        const access = await this.#pairings.authorizeProject(computerId, computerControlPermission(command), signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly measureComputerLatency = async (computerId: string, signal: AbortSignal): Promise<number> => {
        const command: ComputerControlCommand = { kind: "computer.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.#pairings.authorizeProject(computerId, computerControlPermission(command), signal);
        const started = performance.now();
        await this.#operations().requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (computerId: string, command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.#pairings.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        return await this.#operations().requestWorkspace(access.scope, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const computers = await this.#pairings.listProjectComputers(computerId, signal);
        if (!computers.some((candidate) => candidate.computerId === computerId)) {
            throw new PairingDirectoryError(
                "computer_access_denied",
                "The project credential cannot access this Computer",
            );
        }
        const access = await this.#pairings.authorizeProject(computerId, ProjectPermission.ComputerRead, signal);
        return await this.#operations().requestAgentSettings(access.scope, command, signal);
    };

    readonly readProjectComputerPairing = (computerId: string, signal: AbortSignal) =>
        this.#pairings.readProjectComputerPairing(computerId, signal);

    readonly redeemComputerPairing: PairingOperations["redeemComputerPairing"] = async (
        computerId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) =>
        await this.#pairings.redeemComputerPairing(computerId, pairingCode, machineName, workspaceName, agents, signal);

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal) =>
        await this.#pairings.authorizePairedHost(computerId, signal);

    readonly revokeProjectComputer = async (computerId: string, signal: AbortSignal): Promise<void> => {
        const revoked = await this.#pairings.revokeProjectComputer(computerId, signal);
        try {
            await this.#relay.disconnectComputer(revoked.access, signal);
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
