import { FILE_FAILED_KIND, type FILE_READ_KIND } from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { streamLocalFile } from "../../../../session/content/session-files.ts";
import type { CommandHandler } from "../../definition.ts";
import { send, sendContentChunk } from "../../transport.ts";

export const handleFileRead: CommandHandler<typeof FILE_READ_KIND> = (
    { externalContent, sessions, signal, socket },
    message,
): void => {
    void streamLocalFile(
        message,
        (response) => send(socket, response),
        (requestId, sequence, bytes) => sendContentChunk(socket, requestId, sequence, bytes),
        signal,
        sessions.findSessions([message.target])[0]?.cwd ?? null,
        externalContent,
    ).catch((error: unknown) => {
        if (socket.readyState !== WebSocket.OPEN || signal.aborted) {
            return;
        }
        send(socket, {
            code: "file_unavailable",
            kind: FILE_FAILED_KIND,
            message: error instanceof Error ? error.message : "The local file is unavailable",
            requestId: message.requestId,
            target: message.target,
        });
    });
};
