import type { NativeSessionQuery } from "../../acp/native-history/preview-contract.ts";
import type { SessionCreationOptions } from "../api/session-api.ts";

/** Keep product identity and media ownership on the caller's side of the adapter. */
export function nativeSessionQuery(options: SessionCreationOptions): NativeSessionQuery {
    const externalize = options.externalizeSessionUpdate;
    return {
        agent: options.agent,
        cwd: options.cwd,
        signal: options.signal,
        ...(externalize === undefined
            ? {}
            : {
                  externalizeUpdate: (_sessionId, update, signal) =>
                      externalize({ harness: options.agent.harness, sessionId: _sessionId }, update, signal),
              }),
    };
}
