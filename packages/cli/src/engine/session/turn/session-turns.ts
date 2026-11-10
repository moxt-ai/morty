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

    readonly start = (command: SessionPromptCommand, attemptId: string, onQueued: () => void): ActiveRuntimeTurn => {
        const turn = this.session(command.target).start(command, attemptId, onQueued);
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

    /** The Session's running turn and the commands waiting behind it, as one synchronous read. */
    readonly executionSnapshot = (
        sessionTarget: NativeSessionTarget,
    ): { readonly turn: ReturnType<ActiveRuntimeTurn["snapshot"]>; readonly queued: QueuedTurnSnapshot } => {
        const current = this.#bySessionTarget.get(sessionTarget)?.turns() ?? [];
        const turn = current.map((candidate) => candidate.snapshot()).find((snapshot) => snapshot !== null) ?? null;
        const queued = current
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
        return { turn, queued };
    };

    readonly admitAndWait = async (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<PromptDispatch> =>
        this.session(turn.command.target).admitAndWait(turn, waitSignal);

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
