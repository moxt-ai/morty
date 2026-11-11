import type { ContentAvailableEvent, ContentWriteCommand, FileReadCommand } from "@morty-build/client/protocol";
import type { ComputerScope } from "../entity/do/session.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "../service/pairing/runtime-control-request.ts";

/** Session operations after the public API has authorized the selected Session. */
export interface SessionRuntimeOperations {
    readonly requestComputerScopeControl: (
        scope: ComputerScope,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => Promise<RuntimeControlResult>;
    readonly readComputerSessionFile: (
        scope: ComputerScope,
        command: FileReadCommand,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly writeComputerSessionContent: (
        scope: ComputerScope,
        command: ContentWriteCommand,
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
    ) => Promise<ContentAvailableEvent>;
}
