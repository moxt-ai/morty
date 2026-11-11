import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    AgentSettingsDiscoveredEvent,
    ContentAvailableEvent,
    ContentWriteCommand,
    FileReadCommand,
    NativeSessionResult,
    NativeSessionTarget,
    SessionAccessGrant,
    WorkspaceEntriesEvent,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { decodeNativeSessionCancel, requestReplyAddress } from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../management/entity/pairing.ts";
import { ComputerScope } from "../entity/session.ts";
import type { RuntimeContext } from "../runtime-context.ts";
import {
    type ComputerControlCommand,
    type ComputerControlResult,
    requestComputerAgentSettings,
    requestComputerContentWrite,
    requestComputerControl,
    requestComputerFile,
    requestComputerWorkspace,
} from "./computer-control-request.ts";

export type LocalSessionOperations = Readonly<ReturnType<typeof createLocalSessionOperations>>;

export function createLocalSessionOperations(cx: RuntimeContext, computerId: string) {
    const checkTarget = (requestedComputer: string) => {
        const latest = cx.services.connections.latest();
        if (requestedComputer !== computerId || latest?.computerId !== computerId) {
            throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
        }
        const daemon = cx.gateways.peers.sockets().find(({ identity }) => identity.role === "daemon");
        if (daemon !== undefined && daemon.identity.computerId !== computerId) {
            throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
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
    const requestComputerScopeControl = async (
        scope: ComputerScope,
        command: ComputerControlCommand,
        signal: AbortSignal,
    ): Promise<ComputerControlResult> => {
        checkTarget(scope.computerId);
        const target = "target" in command ? command.target : undefined;
        const socket = await connect(requestReplyAddress(command), target, signal);
        return await requestComputerControl(socket, command, signal);
    };
    return {
        forkNativeSession: async (
            scope: ComputerScope,
            operationId: string,
            input: ForkMortyNativeSessionRequest,
            signal: AbortSignal,
        ): Promise<NativeSessionResult> => {
            checkTarget(scope.computerId);
            return await cx.services.nativeForks.fork(scope, operationId, input, requestComputerScopeControl, signal);
        },
        requestWorkspace: async (
            scope: ComputerScope,
            command: WorkspaceListCommand,
            signal: AbortSignal,
        ): Promise<WorkspaceEntriesEvent> => {
            checkTarget(scope.computerId);
            return await requestComputerWorkspace(await connect(command.requestId, undefined, signal), command, signal);
        },
        requestAgentSettings: async (
            scope: ComputerScope,
            command: AgentSettingsDiscoverCommand,
            signal: AbortSignal,
        ): Promise<AgentSettingsDiscoveredEvent> => {
            checkTarget(scope.computerId);
            return await requestComputerAgentSettings(
                await connect(command.requestId, undefined, signal),
                command,
                signal,
            );
        },
        openPublicSessionEvents: async (
            scope: ComputerScope,
            sessionTarget: NativeSessionTarget,
            credential: {
                readonly signingKeyId: string;
                readonly grant: SessionAccessGrant;
                readonly expiresAt: number;
            },
            signal: AbortSignal,
        ): Promise<Response> => {
            checkTarget(scope.computerId);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(scope.computerId);
            if (!cx.services.runtime.isOnline(computerId)) {
                throw new PairingDirectoryError("computer_offline", "The Computer is offline");
            }
            return cx.gateways.peers.accept({
                role: "viewer",
                computerId,
                sessionFilter: sessionTarget,
                expiresAt: credential.expiresAt,
                credential: {
                    signingKeyId: credential.signingKeyId,
                    grant: credential.grant,
                },
            }).response;
        },
        requestComputerScopeControl,
        readProjectSessionFile: async (
            scope: ComputerScope,
            command: FileReadCommand,
            signal: AbortSignal,
        ): Promise<Response> => {
            checkTarget(scope.computerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                const stream = await requestComputerFile(socket, command, signal);
                cx.utilities.waitUntil(stream.finished);
                return stream.response;
            } catch (cause) {
                socket.close(1000, "File request ended");
                throw cause;
            }
        },
        writeProjectSessionContent: async (
            scope: ComputerScope,
            command: ContentWriteCommand,
            body: ReadableStream<Uint8Array>,
            signal: AbortSignal,
        ): Promise<ContentAvailableEvent> => {
            checkTarget(scope.computerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                return await requestComputerContentWrite(socket, command, body, signal);
            } catch (cause) {
                socket.close(1000, "Content upload ended");
                throw cause;
            }
        },
    };
}
