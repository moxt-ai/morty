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
    // Runtime operations execute only in the RuntimeRelay that owns the Runtime; every Runtime route reaches it there.
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
            throw new Error("Runtime operations run only in the Runtime's RuntimeRelay");
        }
        return this.#runtimeOperations;
    };

    readonly createProjectRuntimePairing = (
        computerId: string,
        token: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => this.#pairings.createProjectRuntimePairing(computerId, token, idempotencyKey, signal);

    readonly createBrowserCredential = (
        computerId: string,
        token: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => this.#pairings.createBrowserCredential(computerId, token, lifetimeMilliseconds, signal);

    readonly revokeBrowserCredential = (computerId: string, credentialId: string, token: string, signal: AbortSignal) =>
        this.#pairings.revokeBrowserCredential(computerId, credentialId, token, signal);

    readonly probeProject = async (computerId: string, token: string, signal: AbortSignal): Promise<void> => {
        await this.#pairings.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
    };

    readonly listProjectRuntimes = async (computerId: string, token: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(computerId, token, signal);
        return await Promise.all(
            channels.map(
                async (channel) =>
                    new RuntimeDescriptor(
                        channel,
                        await this.#channels.readRuntimeStatus(
                            new VerifiedChannelAccess(channel.channelId, channel.runtimeId, channel.computerId, []),
                            signal,
                        ),
                    ),
            ),
        );
    };

    readonly getRuntimeAgents = async (computerId: string, runtimeId: string, token: string, signal: AbortSignal) => {
        const channels = await this.#pairings.listProjectRuntimes(computerId, token, signal);
        const channel = channels.find((candidate) => candidate.runtimeId === runtimeId);
        if (channel === undefined) {
            // A revoked Runtime is not listed; saying so lets its Machine be paired again instead of waiting for it.
            if (await this.#pairings.isProjectRuntimeRevoked(computerId, runtimeId, token, signal)) {
                throw new PairingDirectoryError("runtime_revoked", "The Runtime has been revoked");
            }
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        return new RuntimeDescriptor(
            channel,
            await this.#channels.readRuntimeStatus(
                new VerifiedChannelAccess(channel.channelId, channel.runtimeId, channel.computerId, []),
                signal,
            ),
        );
    };

    readonly forkNativeSession = async (
        computerId: string,
        runtimeId: string,
        token: string,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, token, ProjectPermission.SessionWrite, signal);
        return await this.#operations().forkNativeSession(access.scope, runtimeId, operationId, input, signal);
    };

    readonly requestControl = async (
        computerId: string,
        runtimeId: string,
        token: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) =>
        await this.requestOperationControl(
            computerId,
            runtimeId,
            token,
            command,
            runtimeControlPermission(command),
            signal,
        );

    /** Runs one command of an operation that needs `permission`, which may be the operation's rather than the command's. */
    readonly requestOperationControl = async (
        computerId: string,
        runtimeId: string,
        token: string,
        command: RuntimeControlCommand,
        permission: ProjectPermission,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, token, permission, signal);
        return await this.#operations().requestComputerScopeControl(access.scope, runtimeId, command, signal);
    };

    readonly readRuntimeDiagnostics = async (
        computerId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => {
        const command = decodeRuntimeDiagnosticsRequest(
            JSON.stringify({ kind: "runtime.diagnostics.read", requestId: crypto.randomUUID() }),
        );
        const access = await this.#pairings.authorizeProject(
            computerId,
            token,
            runtimeControlPermission(command),
            signal,
        );
        return await this.#operations().requestComputerScopeControl(access.scope, runtimeId, command, signal);
    };

    readonly measureRuntimeLatency = async (
        computerId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<number> => {
        const command: RuntimeControlCommand = { kind: "runtime.ping", requestId: `ping_${crypto.randomUUID()}` };
        const access = await this.#pairings.authorizeProject(
            computerId,
            token,
            runtimeControlPermission(command),
            signal,
        );
        const started = performance.now();
        await this.#operations().requestComputerScopeControl(access.scope, runtimeId, command, signal);
        return Math.max(0, Math.round(performance.now() - started));
    };

    readonly listWorkspace = async (
        computerId: string,
        runtimeId: string,
        token: string,
        command: WorkspaceListCommand,
        signal: AbortSignal,
    ) => {
        const access = await this.#pairings.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestWorkspace(access.scope, runtimeId, command, signal);
    };

    readonly discoverAgentSettings = async (
        computerId: string,
        runtimeId: string,
        token: string,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => {
        const runtimes = await this.#pairings.listProjectRuntimes(computerId, token, signal);
        if (!runtimes.some((candidate) => candidate.runtimeId === runtimeId)) {
            throw new PairingDirectoryError(
                "runtime_access_denied",
                "The project credential cannot access this Runtime",
            );
        }
        const access = await this.#pairings.authorizeProject(computerId, token, ProjectPermission.RuntimeRead, signal);
        return await this.#operations().requestAgentSettings(access.scope, runtimeId, command, signal);
    };

    readonly readProjectRuntimePairing = (computerId: string, pairingId: string, token: string, signal: AbortSignal) =>
        this.#pairings.readProjectRuntimePairing(computerId, pairingId, token, signal);

    readonly redeemRuntimePairing: PairingOperations["redeemRuntimePairing"] = async (
        pairingId,
        pairingCode,
        machineName,
        workspaceName,
        agents,
        signal,
    ) => await this.#pairings.redeemRuntimePairing(pairingId, pairingCode, machineName, workspaceName, agents, signal);

    readonly authorizeProjectRuntimeHost = async (
        computerId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ) => await this.#pairings.authorizeProjectRuntimeHost(computerId, runtimeId, token, signal);

    readonly revokeProjectRuntime = async (
        computerId: string,
        runtimeId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const revoked = await this.#pairings.revokeProjectRuntime(computerId, runtimeId, token, signal);
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
