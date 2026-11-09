import type { ContentAvailableEvent, ContentWriteCommand, FileReadCommand } from "@morty-build/client/protocol";
import type { ComputerScope } from "../entity/do/session.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "../service/pairing/runtime-control-request.ts";

/** Session operations after the public API has authorized the selected Session. */
export interface SessionRuntimeOperations {
    readonly requestComputerScopeControl: (
        scope: ComputerScope,
        pairingId: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => Promise<RuntimeControlResult>;
    readonly readProjectSessionFile: (
        scope: ComputerScope,
        pairingId: string,
        command: FileReadCommand,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly writeProjectSessionContent: (
        scope: ComputerScope,
        pairingId: string,
        command: ContentWriteCommand,
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
    ) => Promise<ContentAvailableEvent>;
}
