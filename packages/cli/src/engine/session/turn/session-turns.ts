import type { NativeSessionResult, SessionLiveEvent, SessionPromptCommand } from "@morty-build/client/protocol";
import type { ActiveRuntimeTurn, PromptDispatch, RecordedSessionEvent } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";
import { RuntimeTurnActivity } from "./runtime-turn-activity.ts";
import { SessionExecutionState } from "./session-execution.ts";

type QueuedTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["queued"];

/** Runtime-owned index over per-session execution state; owns no session state itself. */
export class SessionTurns {
    readonly #bySessionId = new Map<string, SessionExecutionState>();
    readonly #operations: ExecutionReceipts;
    readonly #activity: RuntimeTurnActivity;

    constructor(operations: ExecutionReceipts, activity = new RuntimeTurnActivity()) {
        this.#operations = operations;
        this.#activity = activity;
    }

    readonly acceptsPrompts = (): boolean => this.#activity.acceptsPrompts();

    readonly session = (sessionId: string): SessionExecutionState => {
        let session = this.#bySessionId.get(sessionId);
        if (session === undefined) {
            session = new SessionExecutionState(sessionId, this.#operations);
            this.#bySessionId.set(sessionId, session);
        }
        return session;
    };

    readonly get = (commandId: string, sessionId: string): ActiveRuntimeTurn | undefined =>
        this.#bySessionId.get(sessionId)?.get(commandId);

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveRuntimeTurn => {
        const turn = this.session(command.sessionId).start(command, attemptId);
        this.#activity.start(turn);
        return turn;
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#bySessionId.get(turn.command.sessionId)?.finish(turn);
        this.sweep();
        this.#activity.finish(turn);
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent =>
        "sessionId" in event ? (this.#bySessionId.get(event.sessionId)?.recordEvent(event) ?? event) : event;

    readonly recordSessionEvent = (event: SessionLiveEvent): void => {
        if (
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "session.permission.requested" ||
                event.payload.kind === "session.permission.resolved" ||
                event.payload.kind === "session.elicitation.requested" ||
                event.payload.kind === "session.elicitation.resolved")
        ) {
            this.recordEvent(event.payload.event);
        }
    };

    /** Resolve identities first, then read every execution projection in one synchronous step. */
    readonly executionSnapshot = async <T>(
        sessionId: string,
        matches: (command: SessionPromptCommand) => Promise<boolean>,
        read: (snapshot: {
            readonly turn: ReturnType<ActiveRuntimeTurn["snapshot"]>;
            readonly queued: QueuedTurnSnapshot;
        }) => T,
        signal: AbortSignal,
    ): Promise<T> => {
        const matched = new Map<ActiveRuntimeTurn, boolean>();
        for (;;) {
            signal.throwIfAborted();
            const current = this.#bySessionId.get(sessionId)?.turns() ?? [];
            const unresolved = current.filter((turn) => !matched.has(turn));
            if (unresolved.length > 0) {
                for (const turn of unresolved) {
                    matched.set(turn, await matches(turn.command));
                }
                // A command may arrive or settle during directory resolution. Re-read the live index.
                continue;
            }
            const matching = current.filter((turn) => matched.get(turn) === true);
            const turn =
                matching.map((candidate) => candidate.snapshot()).find((snapshot) => snapshot !== null) ?? null;
            const queued = matching
                .filter(
                    (candidate) =>
                        candidate.isQueued() &&
                        !this.#operations.isTerminalExecution(candidate.command.commandId, sessionId),
                )
                .map((candidate) => ({
                    commandId: candidate.command.commandId,
                    prompt: candidate.command.prompt,
                    attachments: candidate.command.attachments,
                }));
            // No await between reading the turns and the caller's receipts, interactions and event position.
            return read({ turn, queued });
        }
    };

    readonly admitAndWait = async (
        turn: ActiveRuntimeTurn,
        waitSignal: AbortSignal,
        onQueued: () => void,
    ): Promise<PromptDispatch> => this.session(turn.command.sessionId).admitAndWait(turn, waitSignal, onQueued);

    /** Discards empty session states so the index does not grow unboundedly. */
    readonly sweep = (): void => {
        for (const [sessionId, session] of this.#bySessionId) {
            if (session.isEmpty()) {
                this.#bySessionId.delete(sessionId);
            }
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#bySessionId.values()].map((session) => session.close()));
    };
}
