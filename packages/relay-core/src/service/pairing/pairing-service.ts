import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type { AgentSettingsDiscoverCommand, WorkspaceListCommand } from "@morty-build/client/protocol";
import { decodeRuntimeDiagnosticsRequest } from "@morty-build/client/protocol";
import { ComputerPermission } from "../../entity/authentication/computer-authentication.ts";
import { PairingDirectoryError, VerifiedComputerAccess } from "../../entity/pairing/pairing.ts";
import type { ComputerGateway } from "../../gateway/computer-gateway.ts";
import { ConnectedComputer } from "../computer/computer-status.ts";
import type { LocalSessionOperations } from "../computer/local-session-operations.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { runtimeControlPermission } from "./runtime-control-registry.ts";
import type { RuntimeControlCommand } from "./runtime-control-request.ts";

export class PairingService {
    readonly #computerGateway: ComputerGateway;
    readonly #pairings: PairingOperations;
    // Runtime operations execute only in the ComputerRelay that holds the daemon connection; every Runtime route reaches it there.
    readonly #runtimeOperations: LocalSessionOperations | undefined;

    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly computerGateway: ComputerGateway;
            readonly runtimeOperations?: LocalSessionOperations;
        };
    }) {
        this.#computerGateway = cx.gateways.computerGateway;
        this.#runtimeOperations = cx.gateways.runtimeOperations;
        this.#pairings = cx.services.pairings;
    }

    readonly #operations = (): LocalSessionOperations => {
        if (this.#runtimeOperations === undefined) {
            throw new Error("Runtime operations run only in the ComputerRelay");
        }
        return this.#runtimeOperations;
    };

    readonly createComputerRuntimePairing = (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createComputerRuntimePairing(computerId, pairingKey, idempotencyKey, signal);

    readonly probeComputer = async (computerId: string, signal: AbortSignal): Promise<void> => {
        await this.#pairings.authorizeComputer(computerId, ComputerPermission.RuntimeRead, signal);
    };

    readonly listComputerRuntimes = async (computerId: string, signal: AbortSignal) => {
        const computers = await this.#pairings.listComputerRuntimes(computerId, signal);
        return await Promise.all(
            computers.map(
                async (computer) =>
                    new ConnectedComputer(
                        computer,
                        await this.#computerGateway.readRuntimeStatus(
                            new VerifiedComputerAccess(computer.computerId, []),
                            signal,
                        ),
                    ),
            ),
        );
    };

    readonly getRuntimeAgents = async (computerId: string, signal: AbortSignal) => {
        const computers = await this.#pairings.listComputerRuntimes(computerId, signal);
        const computer = computers.find((candidate) => candidate.computerId === computerId);
        if (computer === undefined) {
            // A revoked Runtime is not listed; saying so lets its Machine be paired again instead of waiting for it.
            if (await this.#pairings.isComputerRuntimeRevoked(computerId, signal)) {
                throw new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
            }
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The computer credential cannot access this Runtime",
            );
        }
        return new ConnectedComputer(
            computer,
            await this.#computerGateway.readRuntimeStatus(new VerifiedComputerAccess(computer.computerId, []), signal),
        );
    };

    readonly forkNativeSession = async (
        computerId: string,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeComputer(computerId, ComputerPermission.SessionWrite, signal);
        return await this.#operations().forkNativeSession(access.scope, operationId, input, signal);
    };

    readonly requestControl = async (computerId: string, command: RuntimeControlCommand, signal: AbortSignal) =>
        await this.requestOperationControl(computerId, command, runtimeControlPermission(command), signal);

    /** Runs one command of an operation that needs `permission`, which may be the operation's rather than the command's. */
    readonly requestOperationControl = async (
        computerId: string,
        command: RuntimeControlCommand,
        permission: ComputerPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeComputer(computerId, permission, signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly readRuntimeDiagnostics = async (computerId: string, signal: AbortSignal) => {
        const command = decodeRuntimeDiagnosticsRequest(
            JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        const access = await this.#pairings.authorizeComputer(computerId, runtimeControlPermission(command), signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly measureRuntimeLatency = async (computerId: string, signal: AbortSignal): Promise<number> => {
        const command: RuntimeControlCommand = { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.#pairings.authorizeComputer(computerId, runtimeControlPermission(command), signal);
        const started = performance.now();
        await this.#operations().requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (computerId: string, command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.#pairings.authorizeComputer(computerId, ComputerPermission.RuntimeRead, signal);
        return await this.#operations().requestWorkspace(access.scope, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.#pairings.listComputerRuntimes(computerId, signal);
        if (!runtimes.some((candidate) => candidate.computerId === computerId)) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The computer credential cannot access this Runtime",
            );
        }
        const access = await this.#pairings.authorizeComputer(computerId, ComputerPermission.RuntimeRead, signal);
        return await this.#operations().requestAgentSettings(access.scope, command, signal);
    };

    readonly readComputerRuntimePairing = (computerId: string, signal: AbortSignal) =>
        this.#pairings.readComputerRuntimePairing(computerId, signal);

    readonly redeemRuntimePairing: PairingOperations["redeemRuntimePairing"] = async (
        computerId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) => await this.#pairings.redeemRuntimePairing(computerId, pairingCode, machineName, workspaceName, agents, signal);

    readonly authorizePairedHost = async (computerId: string, signal: AbortSignal) =>
        await this.#pairings.authorizePairedHost(computerId, signal);

    readonly revokeComputerRuntime = async (computerId: string, signal: AbortSignal): Promise<void> => {
        const revoked = await this.#pairings.revokeComputerRuntime(computerId, signal);
        try {
            await this.#computerGateway.disconnectRuntime(revoked.access, signal);
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
