import type { SessionMessage } from "./session-presentation.ts";

export type SessionDebugBlock = SessionMessage;

export function sessionDebugBlocks(state: {
    readonly messages: readonly SessionMessage[];
}): readonly SessionDebugBlock[] {
    return Object.freeze(structuredClone(state.messages));
}
