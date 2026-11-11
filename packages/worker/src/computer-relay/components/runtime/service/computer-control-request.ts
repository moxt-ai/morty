import {
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    CONTENT_AVAILABLE_KIND,
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_READY_KIND,
    type ComputerDiagnosticsRequest,
    type ComputerDiagnosticsResult,
    type ComputerPingCommand,
    type ComputerPongEvent,
    type ContentAvailableEvent,
    type ContentWriteCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeComputerStatusEvent,
    decodeContentAvailableEvent,
    decodeContentChunkFrame,
    decodeContentReadyEvent,
    decodeFileBeginEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    decodeWorkspaceEntriesEvent,
    encodeContentChunkFrame,
    encodeNativeSessionRequest,
    encodeServiceToDaemonMessage,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    type FileReadCommand,
    type NativeSessionRequest,
    type NativeSessionResult,
    requestReplyAddress,
    type SessionArchiveCommand,
    type SessionArchivedEvent,
    type SessionCancelBeforeStartCommand,
    type SessionCancelCommand,
    type SessionCloseCommand,
    type SessionClosedEvent,
    type SessionConfigReadCommand,
    type SessionConfigReadResult,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionCreateCommand,
    type SessionCreationReadCommand,
    type SessionElicitationRespondCommand,
    type SessionHistoryPageLoad,
    type SessionHistoryWirePageLoaded,
    type SessionInteractionAnsweredEvent,
    type SessionListCommand,
    type SessionPermissionRespondCommand,
    type SessionPrepareCommand,
    type SessionPreviewHistoryPageLoad,
    type SessionPreviewHistoryWirePageLoaded,
    type SessionPromptAcceptedEvent,
    type SessionPromptCommand,
    type SessionPromptDispositionCommand,
    type SessionPromptSteeredEvent,
    type SessionQueryCommand,
    type SessionReadyEvent,
    type SessionRenameCommand,
    type SessionRenamedEvent,
    type SessionRestoreCommand,
    type SessionRestoredEvent,
    type SessionsListedEvent,
    type SessionsQueriedEvent,
    type SessionTurnStoppedEvent,
    type SessionTurnWithdrawnEvent,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { RuntimeOperationFailedError, SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { computerControlRegistry } from "./computer-control-registry.ts";

export interface ComputerReplyConnection {
    readonly readyState: number;
    readonly accept: () => void;
    readonly send: (message: string | ArrayBuffer | ArrayBufferView) => void;
    readonly close: (code?: number, reason?: string) => void;
    readonly addEventListener: EventTarget["addEventListener"];
    readonly removeEventListener: EventTarget["removeEventListener"];
}

export type ComputerControlCommand =
    | ComputerDiagnosticsRequest
    | ComputerPingCommand
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionCreateCommand
    | SessionCreationReadCommand
    | SessionConfigureCommand
    | SessionConfigReadCommand
    | SessionRenameCommand
    | SessionCloseCommand
    | SessionArchiveCommand
    | SessionCancelBeforeStartCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionPreviewHistoryPageLoad
    | SessionHistoryPageLoad
    | SessionElicitationRespondCommand
    | SessionPermissionRespondCommand
    | SessionListCommand
    | SessionQueryCommand
    | SessionRestoreCommand;

export type ComputerControlResult =
    | ComputerDiagnosticsResult
    | ComputerPongEvent
    | NativeSessionResult
    | SessionReadyEvent
    | SessionConfigUpdatedEvent
    | SessionConfigReadResult
    | SessionRenamedEvent
    | SessionClosedEvent
    | SessionArchivedEvent
    | SessionPromptAcceptedEvent
    | SessionPromptSteeredEvent
    | SessionTurnStoppedEvent
    | SessionTurnWithdrawnEvent
    | SessionPreviewHistoryWirePageLoaded
    | SessionHistoryWirePageLoaded
    | SessionInteractionAnsweredEvent
    | SessionsListedEvent
    | SessionsQueriedEvent
    | SessionRestoredEvent;

export interface ComputerFileStream {
    readonly finished: Promise<void>;
    readonly response: Response;
}

export async function requestComputerContentWrite(
    socket: ComputerReplyConnection,
    command: ContentWriteCommand,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
): Promise<ContentAvailableEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer content upload timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    let uploadStarted = false;
    let upload: Promise<void> = Promise.resolve();
    try {
        return await new Promise<ContentAvailableEvent>((resolve, reject) => {
            const fail = (cause: unknown): void => reject(cause);
            const onClose = (): void =>
                fail(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
            const onAbort = (): void => fail(deadline.reason);
            const sendBody = async (): Promise<void> => {
                const reader = body.getReader();
                let sequence = 0;
                let sentBytes = 0;
                try {
                    while (true) {
                        deadline.throwIfAborted();
                        const chunk = await reader.read();
                        if (chunk.done) {
                            break;
                        }
                        for (let offset = 0; offset < chunk.value.byteLength; offset += CONTENT_CHUNK_MAX_BYTES) {
                            const bytes = chunk.value.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES);
                            sentBytes += bytes.byteLength;
                            if (sentBytes > command.byteLength) {
                                throw new SessionRuntimeError(
                                    "invalid_request",
                                    "The content body exceeds its declared size",
                                );
                            }
                            socket.send(encodeContentChunkFrame({ bytes, requestId: command.requestId, sequence }));
                            sequence += 1;
                        }
                    }
                    if (sentBytes !== command.byteLength) {
                        throw new SessionRuntimeError("invalid_request", "The content body has an unexpected size");
                    }
                    socket.send(
                        encodeServiceToDaemonMessage({
                            kind: "content.commit",
                            requestId: command.requestId,
                            target: command.target,
                        }),
                    );
                } finally {
                    reader.releaseLock();
                }
            };
            const onMessage = (event: Event): void => {
                if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
                    return;
                }
                try {
                    const kind = decodeMessageKind(event.data);
                    if (kind === "computer.status") {
                        if (!decodeComputerStatusEvent(event.data).online) {
                            onClose();
                        }
                        return;
                    }
                    if (kind === FILE_FAILED_KIND) {
                        const failure = decodeFileFailedEvent(event.data);
                        if (failure.requestId === command.requestId) {
                            fail(new SessionRuntimeError(failure.code, failure.message));
                        }
                        return;
                    }
                    if (kind === CONTENT_READY_KIND) {
                        const ready = decodeContentReadyEvent(event.data);
                        if (ready.requestId !== command.requestId || uploadStarted) {
                            return;
                        }
                        uploadStarted = true;
                        upload = sendBody().catch(fail);
                        return;
                    }
                    if (kind === CONTENT_AVAILABLE_KIND) {
                        const available = decodeContentAvailableEvent(event.data);
                        if (
                            available.requestId !== command.requestId ||
                            available.contentKey !== command.contentKey ||
                            available.byteLength !== command.byteLength
                        ) {
                            throw new SessionRuntimeError(
                                "invalid_request",
                                "The Computer returned invalid content metadata",
                            );
                        }
                        resolve(available);
                    }
                } catch (cause) {
                    fail(cause);
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            try {
                deadline.throwIfAborted();
                socket.accept();
                socket.send(encodeServiceToDaemonMessage(command));
            } catch (cause) {
                fail(cause);
            }
        });
    } finally {
        clearTimeout(timer);
        cleanup();
        await upload.catch(() => undefined);
        socket.close(1000, "Operation finished");
    }
}

export async function requestComputerFile(
    socket: ComputerReplyConnection,
    command: FileReadCommand,
    signal: AbortSignal,
): Promise<ComputerFileStream> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let settleFinished = () => {};
    const finished = new Promise<void>((resolve) => {
        settleFinished = resolve;
    });
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let responseSettled = false;
    let transferFinished = false;
    let expectedBytes = 0;
    let receivedBytes = 0;
    let nextSequence = 0;
    let cleanup = () => {};
    const response = await new Promise<Response>((resolve, reject) => {
        const finish = (): void => {
            if (transferFinished) {
                return;
            }
            transferFinished = true;
            clearTimeout(timer);
            cleanup();
            socket.close(1000, "Operation finished");
            settleFinished();
        };
        const fail = (cause: unknown): void => {
            if (transferFinished) {
                return;
            }
            if (responseSettled) {
                stream?.error(cause);
            } else {
                reject(cause);
            }
            finish();
        };
        const onClose = (): void => fail(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
        const onAbort = (): void => fail(deadline.reason);
        const onMessage = (event: Event): void => {
            if (!(event instanceof MessageEvent)) {
                return;
            }
            try {
                if (typeof event.data !== "string") {
                    const chunk = decodeContentChunkFrame(event.data);
                    if (chunk.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || chunk.sequence !== nextSequence) {
                        throw new SessionRuntimeError("invalid_request", "The Computer returned invalid file chunks");
                    }
                    receivedBytes += chunk.bytes.byteLength;
                    if (receivedBytes > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer exceeded the file size limit");
                    }
                    nextSequence += 1;
                    stream?.enqueue(chunk.bytes);
                    return;
                }
                const kind = decodeMessageKind(event.data);
                if (kind === "computer.status") {
                    if (!decodeComputerStatusEvent(event.data).online) {
                        onClose();
                    }
                    return;
                }
                if (kind === FILE_FAILED_KIND) {
                    const failure = decodeFileFailedEvent(event.data);
                    if (failure.requestId === command.requestId) {
                        fail(new SessionRuntimeError(failure.code, failure.message));
                    }
                    return;
                }
                if (kind === FILE_BEGIN_KIND) {
                    const begin = decodeFileBeginEvent(event.data);
                    if (begin.requestId !== command.requestId) {
                        return;
                    }
                    if (responseSettled || begin.byteLength > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer returned invalid file metadata");
                    }
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                        cancel() {
                            finish();
                        },
                    });
                    responseSettled = true;
                    expectedBytes = begin.byteLength;
                    resolve(
                        new Response(body, {
                            headers: {
                                "cache-control": "no-store",
                                "content-length": begin.byteLength.toString(),
                                "content-type": begin.mediaType,
                                "last-modified": new Date(begin.modifiedAt).toUTCString(),
                                "x-morty-byte-length": begin.byteLength.toString(),
                                "x-morty-file-name": encodeURIComponent(begin.name),
                            },
                        }),
                    );
                    return;
                }
                if (kind === FILE_END_KIND) {
                    const end = decodeFileEndEvent(event.data);
                    if (end.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || receivedBytes !== expectedBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer ended an unknown file stream");
                    }
                    stream?.close();
                    finish();
                }
            } catch (cause) {
                fail(
                    cause instanceof SessionRuntimeError
                        ? cause
                        : new SessionRuntimeError("invalid_request", "The Computer returned an invalid file", {
                              cause,
                          }),
                );
            }
        };
        cleanup = () => {
            deadline.removeEventListener("abort", onAbort);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onClose);
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onClose);
        deadline.addEventListener("abort", onAbort, { once: true });
        try {
            deadline.throwIfAborted();
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        } catch (cause) {
            fail(cause);
        }
    });
    return { finished, response };
}

export async function requestComputerAgentSettings(
    socket: ComputerReplyConnection,
    command: AgentSettingsDiscoverCommand,
    signal: AbortSignal,
): Promise<AgentSettingsDiscoveredEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<AgentSettingsDiscoveredEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const kind = decodeMessageKind(event.data);
                    if (kind === "computer.status") {
                        if (!decodeComputerStatusEvent(event.data).online) {
                            reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
                        }
                        return;
                    }
                    if (kind === "agent.settings.discovery.failed") {
                        const failed = decodeAgentSettingsDiscoveryFailedEvent(event.data);
                        if (failed.requestId === command.requestId) {
                            reject(new SessionRuntimeError(failed.code, failed.message));
                        }
                        return;
                    }
                    if (kind !== "agent.settings.discovered") {
                        return;
                    }
                    const result = decodeAgentSettingsDiscoveredEvent(event.data);
                    if (result.requestId === command.requestId) {
                        resolve(result);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Computer returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        });
    } finally {
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestComputerControl(
    socket: ComputerReplyConnection,
    command: ComputerControlCommand,
    signal: AbortSignal,
): Promise<ComputerControlResult> {
    const reply = computerControlRegistry[command.kind];
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    const requestId = requestReplyAddress(command);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<ComputerControlResult>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
            const onAbort = () => {
                if (command.kind === "native.session.request" && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        encodeServiceToDaemonMessage({
                            kind: "native.session.cancel",
                            requestId: command.requestId,
                        }),
                    );
                }
                reject(deadline.reason);
            };
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const kind = decodeMessageKind(event.data);
                    if (kind === "computer.status") {
                        if (!decodeComputerStatusEvent(event.data).online) {
                            reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
                        }
                        return;
                    }
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(event.data);
                        if (failed.requestId === requestId) {
                            reject(
                                new RuntimeOperationFailedError(failed.code, failed.message, {
                                    runtimeTimings: failed.runtimeTimings,
                                }),
                            );
                        }
                        return;
                    }
                    if (kind !== reply.eventKind) {
                        return;
                    }
                    const resolved = reply.decode(event.data);
                    if (resolved.requestId === requestId) {
                        resolve(resolved);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Computer returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(
                command.kind === "native.session.request"
                    ? encodeNativeSessionRequest(command)
                    : encodeServiceToDaemonMessage(command),
            );
        });
    } finally {
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}

export async function requestComputerWorkspace(
    socket: ComputerReplyConnection,
    command: WorkspaceListCommand,
    signal: AbortSignal,
): Promise<WorkspaceEntriesEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let cleanup = () => {};
    try {
        deadline.throwIfAborted();
        return await new Promise<WorkspaceEntriesEvent>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
            const onAbort = () => reject(deadline.reason);
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }
                try {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    const kind = decodeMessageKind(event.data);
                    if (kind === "session.operation.failed") {
                        const failed = decodeSessionOperationFailedEvent(event.data);
                        if (failed.requestId === command.requestId) {
                            reject(
                                new SessionRuntimeError(failed.code, failed.message, {
                                    runtimeTimings: failed.runtimeTimings,
                                }),
                            );
                        }
                        return;
                    }
                    if (kind !== "workspace.entries") {
                        return;
                    }
                    const result = decodeWorkspaceEntriesEvent(event.data);
                    if (result.requestId === command.requestId) {
                        resolve(result);
                    }
                } catch (cause) {
                    reject(
                        new SessionRuntimeError("invalid_request", "The Computer returned an invalid response", {
                            cause,
                        }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        });
    } finally {
        clearTimeout(timer);
        cleanup();
        socket.close(1000, "Operation finished");
    }
}
