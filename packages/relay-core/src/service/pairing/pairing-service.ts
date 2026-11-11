import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type { AgentSettingsDiscoverCommand, WorkspaceListCommand } from "@morty-build/client/protocol";
import { decodeRuntimeDiagnosticsRequest } from "@morty-build/client/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError, VerifiedChannelAccess } from "../../entity/pairing/pairing.ts";
import type { ChannelGateway } from "../../gateway/channel-gateway.ts";
import { RuntimeDescriptor } from "../channel/channel.ts";
import type { LocalSessionOperations } from "../channel/local-session-operations.ts";
import type { PairingOperations } from "./pairing-operations.ts";
import { runtimeControlPermission } from "./runtime-control-registry.ts";
import type { RuntimeControlCommand } from "./runtime-control-request.ts";

export class PairingService {
    readonly #channels: ChannelGateway;
    readonly #pairings: PairingOperations;
    // Runtime operations execute only in the ComputerRelay that holds the daemon connection; every Runtime route reaches it there.
    readonly #runtimeOperations: LocalSessionOperations | undefined;

    constructor(cx: {
        readonly services: { readonly pairings: PairingOperations };
        readonly gateways: {
            readonly channelGateway: ChannelGateway;
            readonly runtimeOperations?: LocalSessionOperations;
        };
    }) {
        this.#channels = cx.gateways.channelGateway;
        this.#runtimeOperations = cx.gateways.runtimeOperations;
        this.#pairings = cx.services.pairings;
    }

    readonly #operations = (): LocalSessionOperations => {
        if (this.#runtimeOperations === undefined) {
            throw new Error("Runtime operations run only in the ComputerRelay");
        }
        return this.#runtimeOperations;
    };

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
                    new RuntimeDescriptor(
                        channel,
                        await this.#channels.readRuntimeStatus(
                            new VerifiedChannelAccess(channel.computerId, []),
                            signal,
                        ),
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
        return new RuntimeDescriptor(
            channel,
            await this.#channels.readRuntimeStatus(new VerifiedChannelAccess(channel.computerId, []), signal),
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

    readonly requestControl = async (computerId: string, command: RuntimeControlCommand, signal: AbortSignal) =>
        await this.requestOperationControl(computerId, command, runtimeControlPermission(command), signal);

    /** Runs one command of an operation that needs `permission`, which may be the operation's rather than the command's. */
    readonly requestOperationControl = async (
        computerId: string,
        command: RuntimeControlCommand,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, permission, signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly readRuntimeDiagnostics = async (computerId: string, signal: AbortSignal) => {
        const command = decodeRuntimeDiagnosticsRequest(
            JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        const access = await this.#pairings.authorizeProject(computerId, runtimeControlPermission(command), signal);
        return await this.#operations().requestComputerScopeControl(access.scope, command, signal);
    };

    readonly measureRuntimeLatency = async (computerId: string, signal: AbortSignal): Promise<number> => {
        const command: RuntimeControlCommand = { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.#pairings.authorizeProject(computerId, runtimeControlPermission(command), signal);
        const started = performance.now();
        await this.#operations().requestComputerScopeControl(access.scope, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (computerId: string, command: WorkspaceListCommand, signal: AbortSignal) => {
        const access = await this.#pairings.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestWorkspace(access.scope, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.#pairings.listProjectRuntimes(computerId, signal);
        if (!runtimes.some((candidate) => candidate.computerId === computerId)) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        const access = await this.#pairings.authorizeProject(computerId, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestAgentSettings(access.scope, command, signal);
    };

    readonly readProjectRuntimePairing = (computerId: string, signal: AbortSignal) =>
        this.#pairings.readProjectRuntimePairing(computerId, signal);

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
