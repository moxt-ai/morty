import { AcpExecutionError } from "../../acp/acp-error.ts";
import { type NativeSessionOrigin, sessionIdSchema } from "../../acp/protocol/native-session.ts";
import type { SessionRecovery } from "../api/session-api.ts";
import { FoundStoredSession, StoredSession } from "../record/session-store.ts";
import type { AgentSessionRestore } from "./agent-session-restore.ts";

/** Reopens an established native conversation; this path never creates or assigns a destination. */
export async function restoreSession(
    session: AgentSessionRestore,
    signal: AbortSignal,
    recovery: SessionRecovery,
    origin?: NativeSessionOrigin,
): Promise<void> {
    if (origin?.kind === "fork") {
        throw new AcpExecutionError(
            "A fork must obtain its destination from the harness",
            {},
            "invalid_native_session_request",
        );
    }
    const stored = session.metrics.measureSync("session-state-read", () =>
        origin?.kind === "import"
            ? new FoundStoredSession(
                  new StoredSession(
                      {
                          harness: session.harness,
                          sessionId: sessionIdSchema.parse(origin.sessionId),
                      },
                      session.cwd,
                      true,
                      origin.title,
                  ),
              )
            : session.store.read(session.target),
    );
    if (!(stored instanceof FoundStoredSession)) {
        throw new AcpExecutionError("The native Session was not found", {}, "session_not_found");
    }
    const conversation = stored.session;
    if (conversation.harness !== session.harness || conversation.cwd !== session.cwd) {
        throw new AcpExecutionError("The native Session workspace cannot change", {}, "session_identity_mismatch");
    }
    session.selectNativeSession(conversation.sessionId);
    session.setPrompted(conversation.prompted);
    session.setSessionTitle(conversation.title);
    session.setRestored(true);
    const opened = await session.metrics.measure("session-load", async () => {
        if (recovery.kind === "history-required") {
            if (!session.capabilities.loadSession) {
                throw new AcpExecutionError(
                    "This Agent restores context but does not provide message history.",
                    {},
                    "native_history_unsupported",
                );
            }
            return await session.openSessionWithReplay(signal);
        }
        if (session.capabilities.resumeSession) {
            return await session.openSession(signal);
        }
        if (session.capabilities.loadSession) {
            return await session.openSessionWithReplay(signal);
        }
        throw new AcpExecutionError("The harness cannot restore its native Session", {}, "session_restore_unsupported");
    });
    if (opened.sessionId !== conversation.sessionId) {
        throw new AcpExecutionError(
            "The harness restored a different native Session",
            {},
            "invalid_native_session_response",
        );
    }
    session.applySessionOpened(opened);
    await session.restoreStoredConfigurations(conversation, signal);
    signal.throwIfAborted();
    session.writeStoredSession(conversation.updatedAt);
}
