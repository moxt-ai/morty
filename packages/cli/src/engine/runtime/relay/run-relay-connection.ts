import {
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    decodeKnownServiceToDaemonMessage,
    readUndecodedRequestAddress,
} from "@morty-build/client/protocol";
import { type MessageEvent, WebSocket } from "undici";
import type { ResolveAgent } from "../../session/api/session-api.ts";
import type { ExternalContentStore } from "../../session/content/external-content-store.ts";
import type { SessionManager } from "../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { PromptLifecycle } from "../../session/prompt/prompt-lifecycle.ts";
import type { SessionCreations } from "../../session/record/session-creations.ts";
import type { ExecutionReceipts } from "../../session/turn/execution-receipts.ts";
import type { SessionTurns } from "../../session/turn/session-turns.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import { createCommandRegistry } from "../command/registry/index.ts";
import { send } from "../command/transport.ts";
import { replyFailure } from "../command/turn-replies.ts";
import type { RuntimeConfig } from "../config.ts";
import { ComputerRelayRevokedError, isComputerRelayRevocation } from "./computer-revocation.ts";
import { connectRelay } from "./connect.ts";
import type { RelayConnectionDiagnostics } from "./diagnostics.ts";
import { RelayConnectionLiveness } from "./liveness.ts";
import { relayCredentialHeaders } from "./relay-authentication.ts";
import type { RuntimeSessionEventPublisher } from "./session-event-publisher.ts";

/** A bounded local write of the credential the Relay accepted. */
const CREDENTIAL_SAVE_TIMEOUT_MILLISECONDS = 10_000;

function closeRelaySocket(socket: WebSocket, code: number, reason: string): void {
    try {
        socket.close(code, reason);
    } catch (error) {
        console.error("Morty daemon could not close the Relay WebSocket", error);
        try {
            socket.close();
        } catch (fallbackError) {
            console.error("Morty daemon could not release the Relay WebSocket", fallbackError);
        }
    }
}

export interface RelayConnectionOptions {
    readonly resolveAgent: ResolveAgent;
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly sessionCreations: SessionCreations;
    readonly nativeSessions: NativeSessionService;
    readonly operations: ExecutionReceipts;
    readonly publisher: RuntimeSessionEventPublisher;
    readonly eventProjection: PromptLifecycle;
    readonly externalContent: ExternalContentStore;
    readonly sessionTurns: SessionTurns;
    readonly connectionEpoch: number;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly onConnected: () => void;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export async function runRelayConnection({
    resolveAgent,
    config,
    directories,
    sessionTurns,
    sessionCreations,
    nativeSessions,
    operations,
    publisher,
    eventProjection,
    externalContent,
    sessions,
    connectionEpoch,
    diagnostics,
    onConnected,
    signal,
    timer,
}: RelayConnectionOptions): Promise<void> {
    const relayUrl = new URL(config.relayUrl);
    const rotation = await config.credentials.prepare(signal);
    const relay = await connectRelay(relayUrl, relayCredentialHeaders(rotation), signal, (failure, source) => {
        diagnostics.transportFailed(connectionEpoch, failure, source);
    });
    const { socket } = relay;
    // Saving the rotation waits for the Relay to confirm the connection: a Relay can also open a socket only to close it,
    // as it does for a revoked Computer. Until then the next connection repeats the same rotation, which is harmless.
    let rotationSaved: Promise<void> = Promise.resolve();
    diagnostics.connectionOpened(connectionEpoch);
    const connectionController = new AbortController();
    const commands = createCommandRegistry({
        resolveAgent,
        config,
        directories,
        sessions,
        nativeSessions,
        operations,
        eventProjection,
        externalContent,
        sessionTurns,
        sessionCreations,
        diagnostics,
        socket,
        signal: connectionController.signal,
        timer,
    });

    try {
        await new Promise<void>((resolve, reject) => {
            let finished = false;
            let ready = false;

            const cleanup = (): void => {
                connectionLiveness.close();
                signal.removeEventListener("abort", stop);
                socket.removeEventListener("close", handleClose);
                socket.removeEventListener("error", handleError);
                socket.removeEventListener("message", handleMessage);
                publisher.disconnect(socket);
                connectionController.abort();
            };

            const resolveConnection = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                resolve();
            };

            const rejectConnection = (failure: Error): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                reject(failure);
            };

            const stop = (): void => {
                // A planned upgrade can follow the last completion before the batch timer fires.
                publisher.flush();
                diagnostics.connectionClosed(connectionEpoch, 1000, "Daemon stopped", "daemon_stop");
                closeRelaySocket(socket, 1000, "Daemon stopped");
                resolveConnection();
            };

            const failAndClose = (failure: Error, code: number, reason: string, source: string): void => {
                diagnostics.connectionFailed(connectionEpoch, failure, source);
                diagnostics.connectionClosed(connectionEpoch, code, reason, source);
                closeRelaySocket(socket, code, reason);
                rejectConnection(failure);
            };

            const connectionLiveness = new RelayConnectionLiveness(timer, {
                send: (message) => {
                    if (socket.readyState !== WebSocket.OPEN) {
                        return false;
                    }
                    try {
                        send(socket, message);
                        return true;
                    } catch (error) {
                        if (socket.readyState !== WebSocket.OPEN) {
                            return false;
                        }
                        throw error;
                    }
                },
                unresponsive: (timeoutMilliseconds) => {
                    diagnostics.heartbeatTimedOut(connectionEpoch, timeoutMilliseconds);
                    diagnostics.connectionClosed(
                        connectionEpoch,
                        4001,
                        "Relay liveness check timed out",
                        "heartbeat_timeout",
                    );
                    closeRelaySocket(socket, 4001, "Relay liveness check timed out");
                    resolveConnection();
                },
            });

            signal.addEventListener("abort", stop, { once: true });
            const handleClose = (event: CloseEvent): void => {
                diagnostics.connectionClosed(connectionEpoch, event.code, event.reason, "relay");
                if (isComputerRelayRevocation(event.code, event.reason)) {
                    rejectConnection(new ComputerRelayRevokedError(event.code, event.reason));
                    return;
                }
                resolveConnection();
            };
            const handleError = (event: Event): void => {
                if (signal.aborted) {
                    resolveConnection();
                    return;
                }
                const cause = Reflect.get(event, "error");
                const failure = new Error("Relay WebSocket emitted an error", { cause: cause ?? event });
                diagnostics.connectionFailed(connectionEpoch, failure, "socket_error");
                diagnostics.connectionClosed(connectionEpoch, 1006, "WebSocket error", "socket_error");
                rejectConnection(failure);
            };
            const handleMessage = (event: MessageEvent<unknown>): void => {
                const encoded: unknown = event.data;
                if (typeof encoded !== "string") {
                    try {
                        commands.dispatchChunk(encoded);
                    } catch (error) {
                        failAndClose(
                            new Error("Relay sent an invalid content chunk", { cause: error }),
                            4008,
                            "Invalid content chunk",
                            "protocol",
                        );
                    }
                    return;
                }

                try {
                    const message = decodeKnownServiceToDaemonMessage(encoded);
                    if (message === null) {
                        diagnostics.daemonDiagnostic("protocol_message_discarded", "unknown", {
                            reason: "unsupported_message",
                        });
                        refuseUnsupportedRequest(socket, encoded);
                        return;
                    }
                    const kind = message.kind;
                    if (kind === COMPUTER_LIVENESS_READY_KIND) {
                        if (ready) {
                            return;
                        }
                        ready = true;
                        // The Relay made the successor current as it accepted this connection. The save finishes even
                        // when the daemon stops meanwhile: it records what the Relay already holds.
                        rotationSaved = config.credentials.complete(
                            rotation,
                            AbortSignal.timeout(CREDENTIAL_SAVE_TIMEOUT_MILLISECONDS),
                        );
                        rotationSaved.catch((error: unknown) => {
                            if (finished) {
                                return;
                            }
                            failAndClose(
                                new Error("The rotated Computer credential could not be saved", { cause: error }),
                                1011,
                                "Computer credential unavailable",
                                "credential",
                            );
                        });
                        publisher.connect(socket);
                        connectionLiveness.start();
                        onConnected();
                        return;
                    }
                    if (kind === COMPUTER_HEARTBEAT_ACK_KIND) {
                        connectionLiveness.acknowledge();
                        return;
                    }
                    commands.dispatch(message);
                } catch (error) {
                    console.error("Morty daemon rejected a message", error);
                    failAndClose(
                        new Error("Relay sent an invalid protocol message", { cause: error }),
                        4008,
                        "Invalid protocol message",
                        "protocol",
                    );
                }
            };
            socket.addEventListener("close", handleClose);
            socket.addEventListener("error", handleError);
            socket.addEventListener("message", handleMessage);

            if (signal.aborted) {
                stop();
            }
        });
    } finally {
        connectionController.abort();
        await commands.settle();
        // The next connection presents what this one saved.
        await rotationSaved.catch(() => undefined);
        relay.release(new Error("Relay connection released"));
    }
}

/**
 * Answers a request this Computer cannot run, as sent, so its sender learns at once that nothing was executed instead of
 * waiting out its deadline. Only a message naming its own `requestId` can be answered.
 */
function refuseUnsupportedRequest(socket: WebSocket, encoded: string): void {
    const request = readUndecodedRequestAddress(encoded);
    if (request === null) {
        return;
    }
    replyFailure(
        socket,
        request.requestId,
        request.target,
        "unsupported_operation",
        "This Morty Computer does not support the requested operation.",
    );
}
