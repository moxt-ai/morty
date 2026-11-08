import { decodeIdentifier } from "@morty-build/client/protocol";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { DeliveryState } from "./session-delivery-store.ts";
import type { DelegationStage } from "./session-lifecycle.ts";

// The turn the Session pane treats as current: the command the service reported running or accepted from this pane,
// its turn id and when its work started, or how the last reported turn ended. It records only what the service
// reported. A message this pane is still submitting is its delivery's: the activity the pane shows and reports is
// derived from both, so the two cannot disagree. A submission that fails before the service accepts it ran no turn: its
// failure belongs to the Session's delivery.

export type TurnFailure = { readonly code: string; readonly message: string };

export type CurrentTurn = {
    /** The last Runtime terminal outcome observed, retained when a local submission clears its failure. */
    readonly lastEndedCommandId: string | null;
} & (
    | {
          readonly kind: "idle";
          /** The last failure the service reported for a turn, reported until another turn starts or is submitted. */
          readonly failure: (TurnFailure & { readonly commandId: string }) | null;
      }
    | {
          readonly kind: "current";
          readonly commandId: string;
          readonly turnId: string;
          readonly startedAt: number;
          /**
           * How far the native session's owner has taken the command when the Runtime handed it there instead of
           * running it, or null when the Runtime reported no handoff.
           */
          readonly delegation: DelegationStage | null;
      }
);

export type CurrentTurnEvent =
    /** This pane submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "new-turn-submitted" }
    /**
     * The service accepted this pane's submission of a new turn, dated by `startedAt`, when this browser sent it,
     * until the Runtime reports when the turn started.
     */
    | { readonly kind: "accepted"; readonly commandId: string; readonly turnId: string; readonly startedAt: number }
    /**
     * The service reports the command running; it replaces any other current command. `startedAt` is when the Runtime
     * started it, or null when the Runtime does not say: the turn then keeps its date, or is dated by `observedAt`.
     */
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly turnId: string;
          readonly startedAt: number | null;
          readonly observedAt: number;
      }
    /** The Runtime handed the command to the native session's owner, which reached `stage` with it at `at`. */
    | { readonly kind: "delegated"; readonly commandId: string; readonly stage: DelegationStage; readonly at: number }
    /** The service reports the command's turn ended; `failure` explains a failed one. */
    | { readonly kind: "ended"; readonly commandId: string; readonly failure: TurnFailure | null }
    /** Nothing runs any more, as when the Session closed or a reconnect found no running turn. */
    | { readonly kind: "nothing-running" }
    /**
     * With nothing running, the service reports how its last started command ended, as when this pane opens or
     * reconnects after missing that turn's live outcome. `failure` explains a failed one.
     */
    | { readonly kind: "last-turn-reported"; readonly commandId: string; readonly failure: TurnFailure | null };

export const idleTurn: CurrentTurn = { kind: "idle", failure: null, lastEndedCommandId: null };

/** A turn the pane opened with, already running on the service. */
export function openedTurn(running: {
    readonly commandId: string;
    readonly turnId: string;
    readonly startedAt: number;
}): CurrentTurn {
    return {
        kind: "current",
        commandId: decodeIdentifier(running.commandId),
        turnId: decodeIdentifier(running.turnId),
        startedAt: running.startedAt,
        delegation: null,
        lastEndedCommandId: null,
    };
}

function isCurrent(turn: CurrentTurn, commandId: string): turn is Extract<CurrentTurn, { readonly kind: "current" }> {
    return turn.kind === "current" && turn.commandId === commandId;
}

function endedTurn(commandId: string, failure: TurnFailure | null, lastEndedCommandId: string | null): CurrentTurn {
    return { kind: "idle", failure: failure === null ? null : { commandId, ...failure }, lastEndedCommandId };
}

export function transitionCurrentTurn(turn: CurrentTurn, event: CurrentTurnEvent): CurrentTurn {
    switch (event.kind) {
        case "new-turn-submitted":
            return turn.kind === "idle" && turn.failure !== null ? { ...turn, failure: null } : turn;
        case "accepted":
            // Another command the service reports running stays current.
            if (turn.kind === "current") {
                return turn.commandId === event.commandId ? { ...turn, turnId: decodeIdentifier(event.turnId) } : turn;
            }
            // A terminal live event can precede the acceptance response; the turn it ended stays ended.
            return turn.lastEndedCommandId === event.commandId
                ? turn
                : {
                      kind: "current",
                      commandId: event.commandId,
                      turnId: decodeIdentifier(event.turnId),
                      startedAt: event.startedAt,
                      delegation: null,
                      lastEndedCommandId: turn.lastEndedCommandId,
                  };
        case "running":
            return {
                kind: "current",
                commandId: decodeIdentifier(event.commandId),
                turnId: decodeIdentifier(event.turnId),
                // A command the native session's owner runs started when the owner took it.
                startedAt:
                    isCurrent(turn, event.commandId) && turn.delegation === "started"
                        ? turn.startedAt
                        : (event.startedAt ?? (isCurrent(turn, event.commandId) ? turn.startedAt : event.observedAt)),
                delegation: isCurrent(turn, event.commandId) ? turn.delegation : null,
                lastEndedCommandId: turn.lastEndedCommandId,
            };
        case "delegated":
            // The owner never gives a started command back to its queue, whatever order the reports arrive in. Its
            // work started when the owner took it, not when the Runtime handed it over.
            if (!isCurrent(turn, event.commandId) || turn.delegation === "started") {
                return turn;
            }
            return event.stage === "started"
                ? { ...turn, delegation: "started", startedAt: event.at }
                : { ...turn, delegation: "queued" };
        case "ended":
            return isCurrent(turn, event.commandId) ? endedTurn(event.commandId, event.failure, event.commandId) : turn;
        case "nothing-running":
            // Learning that nothing runs cannot resolve an earlier turn failure.
            return turn.kind === "idle" ? turn : { ...idleTurn, lastEndedCommandId: turn.lastEndedCommandId };
        case "last-turn-reported":
            // Repeating an observed Runtime outcome cannot undo a later local submission's result.
            // A genuinely unseen outcome still recovers a turn that ended while this pane was disconnected.
            if (turn.lastEndedCommandId === event.commandId) {
                return turn;
            }
            return turn.kind === "current" && turn.commandId !== event.commandId
                ? { ...turn, lastEndedCommandId: event.commandId }
                : endedTurn(event.commandId, event.failure, event.commandId);
    }
}

/** Whether only the native session's owner can stop the current turn, because it took the command into its own turn. */
export function ownerRunsTurn(turn: CurrentTurn): boolean {
    return turn.kind === "current" && turn.delegation === "started";
}

/**
 * What the pane says about the current turn: waiting in the native session owner's queue, or working since its work
 * started, there or here. Nothing while the turn waits for the user's input.
 */
export type WorkingIndicator =
    | { readonly kind: "queued-in-owner" }
    | { readonly kind: "working"; readonly startedAt: number; readonly inOwner: boolean };

export function workingIndicator(turn: CurrentTurn, waitingForInput: boolean): WorkingIndicator | null {
    if (waitingForInput || turn.kind !== "current") {
        return null;
    }
    return turn.delegation === "queued"
        ? { kind: "queued-in-owner" }
        : { kind: "working", startedAt: turn.startedAt, inOwner: turn.delegation === "started" };
}

/** The command the service accepted as the running turn, with that turn's id. */
export function acceptedTurn(turn: CurrentTurn): { readonly commandId: string; readonly turnId: string } | null {
    return turn.kind === "current" ? { commandId: turn.commandId, turnId: turn.turnId } : null;
}

/**
 * The command of the new turn this pane is submitting and the service has not reported yet: a message sent as a new
 * turn while its delivery is being prepared or submitted. A message queued behind a running turn starts none, and
 * once the service reports the command running or ended, the turn is the service's account.
 */
function submittingCommandId(turn: CurrentTurn, delivery: DeliveryState): string | null {
    if (turn.kind === "current") {
        return null;
    }
    const commandId =
        delivery.kind === "preparing" && delivery.message.placement === "turn"
            ? delivery.message.commandId
            : delivery.kind === "submitting" && delivery.journal.placement === "turn"
              ? delivery.journal.commandId
              : null;
    return commandId === turn.lastEndedCommandId ? null : commandId;
}

/**
 * What the pane reports for the Session: working while a command is current or this pane submits a new turn;
 * otherwise failed while a message that would have started a turn keeps the failure of its preparation, or after the
 * service reported a failed turn; otherwise idle. A message the service rejected reports its failure on the message
 * alone.
 */
export function sessionActivity(turn: CurrentTurn, delivery: DeliveryState): SessionActivityState {
    if (turn.kind === "current") {
        return { kind: "working", commandId: turn.commandId };
    }
    const submitting = submittingCommandId(turn, delivery);
    if (submitting !== null) {
        return { kind: "working", commandId: submitting };
    }
    if (delivery.kind === "preparation-failed" && delivery.message.placement === "turn") {
        return { kind: "failed", commandId: delivery.message.commandId, ...delivery.failure };
    }
    return turn.failure === null ? { kind: "idle" } : { kind: "failed", ...turn.failure };
}
