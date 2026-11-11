import type { ContentAvailableEvent, ContentWriteCommand, FileReadCommand } from "@morty-build/client/protocol";
import type { ComputerScope } from "../entity/do/session.ts";
import type { ComputerControlCommand, ComputerControlResult } from "../service/pairing/computer-control-request.ts";

/** Session operations after the public API has authorized the selected Session. */
export interface SessionRuntimeOperations {
    readonly requestComputerScopeControl: (
        scope: ComputerScope,
        command: ComputerControlCommand,
        signal: AbortSignal,
    ) => Promise<ComputerControlResult>;
    readonly readProjectSessionFile: (
        scope: ComputerScope,
        command: FileReadCommand,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly writeProjectSessionContent: (
        scope: ComputerScope,
        command: ContentWriteCommand,
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
    ) => Promise<ContentAvailableEvent>;
}
