import {
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { ActiveRuntimeTurn, type PromptDispatch, type RecordedSessionEvent } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";

const waitForTurnCompletion = (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<void> => {
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
    readonly #sessionId: string;
    readonly #turnsByCommandId = new Map<string, ActiveRuntimeTurn>();
    readonly #operations: ExecutionReceipts;

    constructor(sessionId: string, operations: ExecutionReceipts) {
        this.#sessionId = sessionId;
        this.#operations = operations;
    }

    readonly isEmpty = (): boolean => this.#turnsByCommandId.size === 0;

    readonly start = (command: SessionPromptCommand, attemptId: string): ActiveRuntimeTurn => {
        const turn = new ActiveRuntimeTurn(
            command,
            attemptId,
            () => this.#operations.hasStarted(command.commandId, this.#sessionId),
            () => this.#operations.startedAt(command.commandId, this.#sessionId),
        );
        this.#turnsByCommandId.set(command.commandId, turn);
        return turn;
    };

    readonly get = (commandId: string): ActiveRuntimeTurn | undefined => this.#turnsByCommandId.get(commandId);

    readonly finish = (turn: ActiveRuntimeTurn): void => {
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
                if (turn.matchesInteraction(event.interactionId, this.#sessionId)) {
                    return turn.recordEvent(event);
                }
            }
        }
        return event;
    };

    readonly turns = (): readonly ActiveRuntimeTurn[] => [...this.#turnsByCommandId.values()];

    readonly close = async (): Promise<void> => {
        const turns = [...this.#turnsByCommandId.values()];
        for (const turn of turns) {
            turn.abortRuntime();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    /**
     * Admits the turn in arrival order. A steering prompt joins the running turn it names. An appended prompt runs
     * when no earlier turn owns an execution, and otherwise waits in the queue until every earlier one ended or the
     * user promotes it to steer the turn it waits behind. Admission never refuses an appended prompt.
     */
    readonly admitAndWait = async (
        turn: ActiveRuntimeTurn,
        waitSignal: AbortSignal,
        onQueued: () => void,
    ): Promise<PromptDispatch> => {
        const command = turn.command;
        waitSignal.throwIfAborted();
        if (command.disposition === SessionPromptDisposition.Steer) {
            return turn.admit({ kind: "steer", targetCommandId: command.targetCommandId });
        }
        // The earliest turn that owns an execution: a promoted prompt steers instead and holds no place.
        const head = (): ActiveRuntimeTurn | undefined =>
            [...this.#turnsByCommandId.values()].find((candidate) => !candidate.isSteering());
        if (head() !== turn) {
            turn.enqueue();
            onQueued();
        }
        for (;;) {
            waitSignal.throwIfAborted();
            const first = head();
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
