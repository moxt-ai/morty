import type { MobiusClient } from "@moxt-ai/mobius-sdk";
import {
    acceptedTurn,
    awaitsService,
    type CurrentTurn,
    type TurnFailure,
    transitionCurrentTurn,
} from "./session-current-turn.ts";
import { type SessionInteractionRecovery, sessionInteractionRecovery } from "./session-lifecycle.ts";
import {
    observeSessionProjectionExecution,
    type SessionProjection,
    sessionProjectionExecutionOwner,
} from "./session-projection.ts";

// What the Session pane knows about the Session's execution: the timeline, the current turn, the Runtime's queue,
// which submissions the Runtime has, and the pending interactions. Every execution fact the pane observes, a live
// lifecycle event or a snapshot read, moves all of them through `observeSessionExecution`, so no entry point can
// update some of them and miss the others.

/** The Runtime's account of the Session's execution, as one read returns it. */
type SessionExecutionSnapshot = Awaited<ReturnType<MobiusClient["sessions"]["readSessionExecution"]>>;

/** A message the Runtime holds queued behind the running turn. */
export type QueuedCommand = SessionExecutionSnapshot["queued"][number];

/** The execution state the pane owns. The Runtime's queue is kept only here; the queue panel derives from it. */
export interface SessionExecution {
    readonly projection: SessionProjection;
    readonly turn: CurrentTurn;
    readonly queued: readonly QueuedCommand[];
}

/** How a turn's live lifecycle says it ended. */
type TurnOutcome =
    | { readonly kind: "completed" }
    /** Steering ended the turn, but its execution goes on; only a snapshot tells what runs now. */
    | { readonly kind: "steered" }
    | { readonly kind: "failed"; readonly failure: TurnFailure };

export type SessionExecutionObservation =
    /**
     * A snapshot the Runtime returned for a read that began while `turnAtRead` was current. Only a turn submitted
     * before the read began can have ended by the time it was served. `deliveryCommandId` names the command whose
     * delivery the read asked for.
     */
    | {
          readonly kind: "snapshot";
          readonly snapshot: SessionExecutionSnapshot;
          readonly turnAtRead: CurrentTurn;
          readonly deliveryCommandId: string | null;
      }
    | { readonly kind: "turn-started"; readonly commandId: string }
    | { readonly kind: "turn-ended"; readonly commandId: string; readonly outcome: TurnOutcome }
    /** The Runtime closed the Session, which runs and queues nothing and asks nothing of the user. */
    | { readonly kind: "closed" };

export interface SessionExecutionChange {
    readonly execution: SessionExecution;
    /** Commands the observation shows the Runtime has, which confirms their delivery. */
    readonly delivered: readonly string[];
    /** Commands the observation shows have left the Runtime's queue: started, withdrawn or no longer listed. */
    readonly leftQueue: readonly string[];
    /** A live turn event says nothing about interactions; a snapshot recovers them, and a closing ends them. */
    readonly interactions:
        | { readonly kind: "kept" }
        | { readonly kind: "recovered"; readonly recovery: SessionInteractionRecovery }
        | { readonly kind: "cleared" };
}

const keptInteractions = { kind: "kept" } as const;

/** The turn id of a command the service reports running: the one it accepted this pane's submission under, if any. */
function runningTurnId(turn: CurrentTurn, commandId: string): string {
    const accepted = acceptedTurn(turn);
    return accepted?.commandId === commandId ? accepted.turnId : commandId;
}

function observeSnapshot(
    execution: SessionExecution,
    observation: Extract<SessionExecutionObservation, { readonly kind: "snapshot" }>,
    startedAt: (commandId: string) => number,
): SessionExecutionChange {
    const { snapshot, turnAtRead, deliveryCommandId } = observation;
    const running = snapshot.turn;
    let turn = execution.turn;
    if (running !== null) {
        turn = transitionCurrentTurn(turn, {
            kind: "running",
            commandId: running.commandId,
            turnId: runningTurnId(turn, running.commandId),
            startedAt: startedAt(running.commandId),
        });
    } else {
        if (awaitsService(turnAtRead)) {
            turn = transitionCurrentTurn(turn, { kind: "nothing-running" });
        }
        // The Runtime's record of the last turn shows an outcome this pane missed. Older Runtimes and Relays omit it,
        // which leaves the turn as before.
        const lastTurn = snapshot.lastTurn;
        if (lastTurn !== undefined) {
            turn = transitionCurrentTurn(turn, {
                kind: "last-turn-reported",
                commandId: lastTurn.commandId,
                failure: lastTurn.state === "failed" ? { code: lastTurn.code, message: lastTurn.message } : null,
            });
        }
    }
    // Only the Runtime knows whether a submission arrived, including one that finished while this pane was away. A
    // Runtime or Relay that cannot report it omits the delivery, and the submission stays unconfirmed. The execution
    // receipt of a running command confirms its delivery even when admission and live events were lost.
    const delivered = [
        ...(deliveryCommandId !== null && snapshot.command !== undefined && snapshot.command.state !== "unknown"
            ? [deliveryCommandId]
            : []),
        ...(running === null ? [] : [running.commandId]),
    ];
    const listed = new Set(snapshot.queued.map((item) => item.commandId));
    return {
        execution: {
            projection: observeSessionProjectionExecution(execution.projection, {
                running: running?.commandId ?? null,
                queued: snapshot.queued.map((item) => item.commandId),
            }),
            turn,
            queued: snapshot.queued,
        },
        delivered,
        leftQueue: execution.queued.flatMap((item) => (listed.has(item.commandId) ? [] : [item.commandId])),
        interactions: { kind: "recovered", recovery: sessionInteractionRecovery(snapshot) },
    };
}

/**
 * Moves the pane's whole execution state by one observed fact. `startedAt` dates a command's work: when this browser
 * sent it, or now.
 */
export function observeSessionExecution(
    execution: SessionExecution,
    observation: SessionExecutionObservation,
    startedAt: (commandId: string) => number,
): SessionExecutionChange {
    switch (observation.kind) {
        case "snapshot":
            return observeSnapshot(execution, observation, startedAt);
        case "turn-started": {
            const { commandId } = observation;
            const owner = sessionProjectionExecutionOwner(execution.projection, commandId);
            return {
                execution: {
                    ...execution,
                    queued: execution.queued.filter((item) => item.commandId !== commandId),
                    // Steering starts a command, not a new execution to stop.
                    turn:
                        owner !== null && owner !== commandId
                            ? execution.turn
                            : transitionCurrentTurn(execution.turn, {
                                  kind: "running",
                                  commandId,
                                  turnId: runningTurnId(execution.turn, commandId),
                                  startedAt: startedAt(commandId),
                              }),
                },
                delivered: [commandId],
                leftQueue: [commandId],
                interactions: keptInteractions,
            };
        }
        case "turn-ended": {
            const { commandId, outcome } = observation;
            return {
                execution: {
                    ...execution,
                    turn:
                        outcome.kind === "steered"
                            ? execution.turn
                            : transitionCurrentTurn(execution.turn, {
                                  kind: "ended",
                                  commandId,
                                  failure: outcome.kind === "failed" ? outcome.failure : null,
                              }),
                },
                delivered: [commandId],
                leftQueue: [],
                interactions: keptInteractions,
            };
        }
        case "closed":
            return {
                execution: {
                    projection: observeSessionProjectionExecution(execution.projection, { running: null, queued: [] }),
                    turn: transitionCurrentTurn(execution.turn, { kind: "nothing-running" }),
                    queued: [],
                },
                delivered: [],
                leftQueue: execution.queued.map((item) => item.commandId),
                interactions: { kind: "cleared" },
            };
        default:
            return observation satisfies never;
    }
}
