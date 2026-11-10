import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    AgentSettingsDiscoveredEvent,
    NativeSessionTarget,
    SessionAccessHolder,
    WorkspaceEntriesEvent,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { decodeNativeSessionCancel, requestReplyAddress } from "@morty-build/client/protocol";
import type { DurableObjectContext } from "../../di/create-durable-object-dependencies.ts";
import type { ComputerScope as Scope } from "../../entity/do/session.ts";
import { ComputerScope } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { SessionRuntimeOperations } from "../../gateway/session-runtime-operations.ts";
import {
    requestRuntimeAgentSettings,
    requestRuntimeContentWrite,
    requestRuntimeControl,
    requestRuntimeFile,
    requestRuntimeWorkspace,
} from "../pairing/runtime-control-request.ts";
import type { NativeSessionForks } from "./native-session-forks.ts";

export interface LocalSessionOperations extends SessionRuntimeOperations {
    readonly forkNativeSession: (
        scope: Scope,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => ReturnType<NativeSessionForks["fork"]>;
    readonly requestWorkspace: (
        scope: Scope,
        command: WorkspaceListCommand,
        signal: AbortSignal,
    ) => Promise<WorkspaceEntriesEvent>;
    readonly requestAgentSettings: (
        scope: Scope,
        command: AgentSettingsDiscoverCommand,
        signal: AbortSignal,
    ) => Promise<AgentSettingsDiscoveredEvent>;
    readonly openPublicSessionEvents: (
        scope: Scope,
        target: NativeSessionTarget,
        credential: {
            readonly credentialId: string;
            readonly signingKeyId: string;
            readonly holder: SessionAccessHolder;
            readonly expiresAt: number;
        },
        signal: AbortSignal,
    ) => Promise<Response>;
}

export function createLocalSessionOperations(cx: DurableObjectContext, computerId: string): LocalSessionOperations {
    const checkTarget = (requestedComputer: string) => {
        const current = cx.services.connections.current();
        if (requestedComputer !== computerId || current?.computerId !== computerId) {
            throw new PairingDirectoryError("runtime_access_denied", "The selected Runtime is unavailable");
        }
        const daemon = cx.gateways.peers.sockets().find(({ identity }) => identity.role === "daemon");
        if (daemon !== undefined && daemon.identity.computerId !== computerId) {
            throw new PairingDirectoryError("runtime_access_denied", "The selected Runtime is unavailable");
        }
    };
    const connect = async (requestId: string, target: NativeSessionTarget | undefined, signal: AbortSignal) => {
        signal.throwIfAborted();
        await cx.services.runtime.expireSilentDaemons();
        return cx.gateways.requests.open(requestId, target, async (socket, message) => {
            if (!signal.aborted) {
                await cx.services.runtime.receiveOperation(new ComputerScope(computerId), socket, message, signal);
                return;
            }
            // The caller has left, but native query cancellation must still reach the daemon.
            if (typeof message !== "string") {
                throw signal.reason;
            }
            const cancellation = decodeNativeSessionCancel(message);
            if (cancellation.requestId !== requestId) {
                throw signal.reason;
            }
            const cleanup = new AbortController();
            const timer = setTimeout(
                () => cleanup.abort(new DOMException("Cancellation timed out", "TimeoutError")),
                15_000,
            );
            try {
                await cx.services.runtime.receiveOperation(
                    new ComputerScope(computerId),
                    socket,
                    message,
                    cleanup.signal,
                );
            } finally {
                clearTimeout(timer);
            }
        });
    };
    const requestComputerScopeControl: SessionRuntimeOperations["requestComputerScopeControl"] = async (
        scope,
        command,
        signal,
    ) => {
        checkTarget(scope.computerId);
        const target = "target" in command ? command.target : undefined;
        const socket = await connect(requestReplyAddress(command), target, signal);
        return await requestRuntimeControl(socket, command, signal);
    };
    return {
        forkNativeSession: async (scope, operationId, input, signal) => {
            checkTarget(scope.computerId);
            return await cx.services.nativeForks.fork(scope, operationId, input, requestComputerScopeControl, signal);
        },
        requestWorkspace: async (scope, command, signal) => {
            checkTarget(scope.computerId);
            return await requestRuntimeWorkspace(await connect(command.requestId, undefined, signal), command, signal);
        },
        requestAgentSettings: async (scope, command, signal) => {
            checkTarget(scope.computerId);
            return await requestRuntimeAgentSettings(
                await connect(command.requestId, undefined, signal),
                command,
                signal,
            );
        },
        openPublicSessionEvents: async (scope, sessionTarget, credential, signal) => {
            checkTarget(scope.computerId);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(scope.computerId);
            if (!cx.services.runtime.isOnline(computerId)) {
                throw new PairingDirectoryError("runtime_offline", "The Runtime is offline");
            }
            return cx.gateways.peers.accept({
                role: "viewer",
                computerId,
                sessionFilter: sessionTarget,
                expiresAt: credential.expiresAt,
                credential: {
                    credentialId: credential.credentialId,
                    signingKeyId: credential.signingKeyId,
                    holder: credential.holder,
                },
            }).response;
        },
        requestComputerScopeControl,
        readProjectSessionFile: async (scope, command, signal) => {
            checkTarget(scope.computerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                const stream = await requestRuntimeFile(socket, command, signal);
                cx.utilities.waitUntil(stream.finished);
                return stream.response;
            } catch (cause) {
                socket.close(1000, "File request ended");
                throw cause;
            }
        },
        writeProjectSessionContent: async (scope, command, body, signal) => {
            checkTarget(scope.computerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                return await requestRuntimeContentWrite(socket, command, body, signal);
            } catch (cause) {
                socket.close(1000, "Content upload ended");
                throw cause;
            }
        },
    };
}
