import { NativeSessionMap } from "@morty-build/client/native-session";
import type {
    NativeSessionResult,
    NativeSessionTarget,
    SessionLiveEvent,
    SessionPromptCommand,
} from "@morty-build/client/protocol";
import type { ActiveRuntimeTurn, PromptDispatch, RecordedSessionEvent } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";
import { RuntimeTurnActivity } from "./runtime-turn-activity.ts";
import { SessionExecutionState } from "./session-execution.ts";

type QueuedTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["queued"];

/** Runtime-owned index over per-session execution state; owns no session state itself. */
export class SessionTurns {
    readonly #bySessionTarget = new NativeSessionMap<SessionExecutionState>();
    readonly #operations: ExecutionReceipts;
    readonly #activity: RuntimeTurnActivity;

    constructor(operations: ExecutionReceipts, activity = new RuntimeTurnActivity()) {
        this.#operations = operations;
        this.#activity = activity;
    }

    readonly acceptsPrompts = (): boolean => this.#activity.acceptsPrompts();

    readonly session = (sessionTarget: NativeSessionTarget): SessionExecutionState => {
        let session = this.#bySessionTarget.get(sessionTarget);
        if (session === undefined) {
            session = new SessionExecutionState(sessionTarget, this.#operations);
            this.#bySessionTarget.set(sessionTarget, session);
        }
        return session;
    };

    readonly get = (commandId: string, sessionTarget: NativeSessionTarget): ActiveRuntimeTurn | undefined =>
        this.#bySessionTarget.get(sessionTarget)?.get(commandId);

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveRuntimeTurn => {
        const turn = this.session(command.target).start(command, attemptId);
        this.#activity.start(turn);
        return turn;
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#bySessionTarget.get(turn.command.target)?.finish(turn);
        this.sweep();
        this.#activity.finish(turn);
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent =>
        "target" in event ? (this.#bySessionTarget.get(event.target)?.recordEvent(event) ?? event) : event;

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
        sessionTarget: NativeSessionTarget,
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
            const current = this.#bySessionTarget.get(sessionTarget)?.turns() ?? [];
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
                        !this.#operations.isTerminalExecution(candidate.command.commandId, sessionTarget),
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
    ): Promise<PromptDispatch> => this.session(turn.command.target).admitAndWait(turn, waitSignal, onQueued);

    /** Discards empty session states so the index does not grow unboundedly. */
    readonly sweep = (): void => {
        for (const [sessionTarget, session] of this.#bySessionTarget) {
            if (session.isEmpty()) {
                this.#bySessionTarget.delete(sessionTarget);
            }
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#bySessionTarget.values()].map((session) => session.close()));
    };
}
