import { createHash } from "node:crypto";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    CONTENT_AVAILABLE_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_READY_KIND,
    CONTENT_WRITE_KIND,
    type ContentChunkFrame,
    type ContentWriteCommand,
    FILE_FAILED_KIND,
} from "@morty-build/client/protocol";
import type { CommandContext } from "../../context.ts";
import type { ComputerCommand } from "../../definition.ts";
import { send } from "../../transport.ts";

interface PendingWrite {
    readonly bytes: Uint8Array;
    readonly command: ContentWriteCommand;
    readonly hash: ReturnType<typeof createHash>;
    readonly receivedBytes: number;
    readonly sequence: number;
}

export interface ContentWriteCommands {
    readonly commands: readonly ComputerCommand[];
    readonly receiveChunk: (frame: ContentChunkFrame) => void;
    readonly settle: () => Promise<void>;
}

export function createContentWriteCommands(context: CommandContext): ContentWriteCommands {
    const pending = new Map<string, PendingWrite>();
    const operations = new Set<Promise<void>>();

    const fail = (command: Pick<ContentWriteCommand, "requestId" | "target">, error: unknown): void => {
        pending.delete(command.requestId);
        send(context.socket, {
            code: "content_write_failed",
            kind: FILE_FAILED_KIND,
            message: error instanceof Error ? error.message : "The content could not be stored",
            requestId: command.requestId,
            target: command.target,
        });
    };

    const write: ComputerCommand = {
        kind: CONTENT_WRITE_KIND,
        handle: (_commandContext, message): void => {
            if (message.kind !== CONTENT_WRITE_KIND) {
                throw new Error("Command kind mismatch");
            }
            const existing = pending.get(message.requestId);
            if (existing !== undefined) {
                if (JSON.stringify(existing.command) !== JSON.stringify(message)) {
                    fail(message, new Error("The content request identifier is already in use"));
                    return;
                }
            } else {
                pending.set(message.requestId, {
                    bytes: new Uint8Array(message.byteLength),
                    command: message,
                    hash: createHash("sha256"),
                    receivedBytes: 0,
                    sequence: 0,
                });
            }
            send(context.socket, {
                kind: CONTENT_READY_KIND,
                requestId: message.requestId,
                target: message.target,
            });
        },
    };

    const commit: ComputerCommand = {
        kind: CONTENT_COMMIT_KIND,
        handle: (_commandContext, message): void => {
            if (message.kind !== CONTENT_COMMIT_KIND) {
                throw new Error("Command kind mismatch");
            }
            const state = pending.get(message.requestId);
            if (state === undefined || !sameNativeSession(state.command.target, message.target)) {
                fail(message, new Error("The content upload is unavailable"));
                return;
            }
            pending.delete(message.requestId);
            const operation = (async () => {
                try {
                    if (state.receivedBytes !== state.command.byteLength) {
                        throw new Error("The content upload ended at an unexpected length");
                    }
                    if (state.hash.digest("hex") !== state.command.contentKey) {
                        throw new Error("The content upload failed integrity validation");
                    }
                    const stored = await context.externalContent.put({
                        bytes: state.bytes,
                        kind: state.command.contentKind,
                        mediaType: state.command.mediaType,
                        name: state.command.name,
                        target: state.command.target,
                        signal: context.signal,
                    });
                    if (stored.key !== state.command.contentKey || stored.byteLength !== state.command.byteLength) {
                        throw new Error("Stored content did not match the upload");
                    }
                    send(context.socket, {
                        byteLength: stored.byteLength,
                        contentKey: stored.key,
                        kind: CONTENT_AVAILABLE_KIND,
                        requestId: message.requestId,
                        target: message.target,
                    });
                } catch (error) {
                    if (!context.signal.aborted) {
                        fail(message, error);
                    }
                }
            })();
            operations.add(operation);
            void operation.finally(() => operations.delete(operation));
        },
    };

    return {
        commands: [write, commit],
        receiveChunk: (frame) => {
            const state = pending.get(frame.requestId);
            if (state === undefined) {
                context.diagnostics.daemonDiagnostic("content_chunk_discarded", frame.requestId, {
                    reason: "upload_unavailable",
                    sequence: frame.sequence.toString(),
                });
                return;
            }
            if (
                frame.sequence !== state.sequence ||
                state.receivedBytes + frame.bytes.byteLength > state.command.byteLength
            ) {
                fail(state.command, new Error("The content upload contains invalid chunks"));
                return;
            }
            state.bytes.set(frame.bytes, state.receivedBytes);
            state.hash.update(frame.bytes);
            pending.set(frame.requestId, {
                ...state,
                receivedBytes: state.receivedBytes + frame.bytes.byteLength,
                sequence: state.sequence + 1,
            });
        },
        settle: async () => {
            pending.clear();
            await Promise.allSettled([...operations]);
        },
    };
}
