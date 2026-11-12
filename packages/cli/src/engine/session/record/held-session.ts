import type { NativeSessionTarget } from "@morty-build/client/protocol";
import type { ResolveAgent, SessionPrepareOptions } from "../api/session-api.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import { resolveSessionDirectory } from "../workspace/resolve-session-directory.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";

/** A Session this Runtime holds, ready to use. */
export interface HeldSession {
    readonly options: SessionPrepareOptions;
    /** The directory the Session runs in, as this Runtime recorded it. */
    readonly directory: string;
    readonly directoryLabel: string;
}

/**
 * Resolves a command that names only a Session's target into the Session this Runtime holds: the Agent its target
 * names, and the directory it records, authorized again before use. A target it holds no Session for is refused as
 * `session_not_found`.
 */
export async function resolveHeldSession(
    sessions: Pick<SessionManager, "heldSession">,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    target: NativeSessionTarget,
    signal: AbortSignal,
): Promise<HeldSession> {
    signal.throwIfAborted();
    const session = sessions.heldSession(target);
    const resolved = await resolveSessionDirectory(directories, session.cwd, signal);
    return {
        options: {
            ...(await resolveAgent(session.harness, signal)),
            cwd: resolved.cwd,
            signal,
            target: session.target,
        },
        directory: session.cwd,
        directoryLabel: resolved.directoryLabel,
    };
}
