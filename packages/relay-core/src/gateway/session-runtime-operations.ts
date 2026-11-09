import type { ContentAvailableEvent, ContentWriteCommand, FileReadCommand } from "@morty-build/client/protocol";
import type { AccountScope } from "../entity/do/session.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "../service/pairing/runtime-control-request.ts";

/** Session operations after the public API has authorized the selected Session. */
export interface SessionRuntimeOperations {
    readonly requestAccountScopeControl: (
        scope: AccountScope,
        runtimeId: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => Promise<RuntimeControlResult>;
    readonly readProjectSessionFile: (
        scope: AccountScope,
        runtimeId: string,
        command: FileReadCommand,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly writeProjectSessionContent: (
        scope: AccountScope,
        runtimeId: string,
        command: ContentWriteCommand,
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
    ) => Promise<ContentAvailableEvent>;
}
