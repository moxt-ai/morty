import {
    type NativeSessionTarget,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { ActiveComputerTurn, type PromptDispatch, type RecordedSessionEvent } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";

/** Whether the Session began executing the command and still holds it, as its execution authority answers. */
export type SessionExecutes = (sessionTarget: NativeSessionTarget, commandId: string) => boolean;

const waitForTurnCompletion = (turn: ActiveComputerTurn, waitSignal: AbortSignal): Promise<void> => {
    waitSignal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (
            result: { readonly kind: "completed" } | { readonly kind: "failed"; readonly error: unknown },
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            waitSignal.removeEventListener("abort", onAbort);
            if (result.kind === "completed") {
                resolve();
            } else {
                reject(result.error);
            }
        };
        const onAbort = (): void => finish({ error: waitSignal.reason, kind: "failed" });
        waitSignal.addEventListener("abort", onAbort, { once: true });
        void turn.completion.then(
            () => finish({ kind: "completed" }),
            (error: unknown) => finish({ error, kind: "failed" }),
        );
    });
};

/**
 * One session's in-flight turns: FIFO admission, steering, and interaction recording. Admission is the only place
 * that decides whether the Session is busy; whether a turn started is read from its execution receipt.
 */
export class SessionExecutionState {
    readonly #sessionTarget: NativeSessionTarget;
    readonly #turnsByCommandId = new Map<string, ActiveComputerTurn>();
    readonly #operations: ExecutionReceipts;
    readonly #executes: SessionExecutes;

    constructor(sessionTarget: NativeSessionTarget, operations: ExecutionReceipts, executes: SessionExecutes) {
        this.#sessionTarget = sessionTarget;
        this.#operations = operations;
        this.#executes = executes;
    }

    readonly isEmpty = (): boolean => this.#turnsByCommandId.size === 0;

    /**
     * Places the prompt in arrival order. An appended prompt behind an earlier turn that owns an execution enters the
     * queue as it arrives, so the queue and its announcements follow arrival order whatever its preparation awaits.
     */
    readonly start = (command: SessionPromptCommand, attemptId: string, onQueued: () => void): ActiveComputerTurn => {
        const turn = new ActiveComputerTurn(
            command,
            attemptId,
            () => this.#operations.hasStarted(command.commandId, this.#sessionTarget),
            () => this.#operations.startedAt(command.commandId, this.#sessionTarget),
            () => this.#executes(this.#sessionTarget, command.commandId),
        );
        this.#turnsByCommandId.set(command.commandId, turn);
        if (command.disposition !== SessionPromptDisposition.Steer && this.#head() !== turn) {
            turn.enqueue();
            onQueued();
        }
        return turn;
    };

    /** The earliest turn that owns an execution: a promoted prompt steers instead and holds no place. */
    readonly #head = (): ActiveComputerTurn | undefined =>
        [...this.#turnsByCommandId.values()].find((candidate) => !candidate.isSteering());

    readonly get = (commandId: string): ActiveComputerTurn | undefined => this.#turnsByCommandId.get(commandId);

    readonly finish = (turn: ActiveComputerTurn): void => {
        this.#turnsByCommandId.delete(turn.command.commandId);
        turn.finish();
    };

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if ("commandId" in event) {
            const turn = this.#turnsByCommandId.get(event.commandId);
            if (turn !== undefined) {
                return turn.recordEvent(event);
            }
        }
        if (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
            for (const turn of this.#turnsByCommandId.values()) {
                if (turn.matchesInteraction(event.interactionId, this.#sessionTarget)) {
                    return turn.recordEvent(event);
                }
            }
        }
        return event;
    };

    readonly turns = (): readonly ActiveComputerTurn[] => [...this.#turnsByCommandId.values()];

    readonly close = async (): Promise<void> => {
        const turns = [...this.#turnsByCommandId.values()];
        for (const turn of turns) {
            turn.abortComputer();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    /**
     * Admits the turn in arrival order. A steering prompt joins the running turn it names. An appended prompt runs
     * when no earlier turn owns an execution, and otherwise waits in the queue it entered on arrival until every earlier
     * one ended or the user promotes it to steer the turn it waits behind. Admission never refuses an appended prompt.
     */
    readonly admitAndWait = async (turn: ActiveComputerTurn, waitSignal: AbortSignal): Promise<PromptDispatch> => {
        const command = turn.command;
        waitSignal.throwIfAborted();
        if (command.disposition === SessionPromptDisposition.Steer) {
            return turn.admit({ kind: "steer", targetCommandId: command.targetCommandId });
        }
        for (;;) {
            waitSignal.throwIfAborted();
            const first = this.#head();
            if (first === undefined || first === turn) {
                return turn.admit({ kind: "own" });
            }
            const promotion = turn.queuePromotion();
            if (promotion === null) {
                throw new Error("The queued prompt cannot be promoted");
            }
            const decision = await Promise.race([
                waitForTurnCompletion(first, waitSignal).then(() => "target-completed" as const),
                promotion.then(() => "promoted" as const),
            ]);
            if (decision === "promoted") {
                return turn.admit({ kind: "steer", targetCommandId: first.command.commandId });
            }
        }
    };
}
