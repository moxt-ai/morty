import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { DeliveryState } from "./session-delivery-store.ts";

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
      }
);

export type CurrentTurnEvent =
    /** This pane submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "new-turn-submitted" }
    /** The service accepted this pane's submission of a new turn, whose work started at `startedAt`. */
    | { readonly kind: "accepted"; readonly commandId: string; readonly turnId: string; readonly startedAt: number }
    /** The service reports the command running; it replaces any other current command. */
    | { readonly kind: "running"; readonly commandId: string; readonly turnId: string; readonly startedAt: number }
    /** The service reports the command's turn ended; `failure` explains a failed one. */
    | { readonly kind: "ended"; readonly commandId: string; readonly failure: TurnFailure | null }
    /** Nothing runs any more, as when the Session closed or a reconnect found no running turn. */
    | { readonly kind: "nothing-running" }
    /**
     * With nothing running, the service reports how its last started command ended, as when this pane opens or
     * reconnects after missing that turn's live outcome. `failure` explains a failed one.
     */
    | { readonly kind: "last-turn-reported"; readonly commandId: string; readonly failure: TurnFailure | null }
    /** This browser sent the command at `sentAt`, which is when its work started. */
    | { readonly kind: "sent-at-known"; readonly commandId: string; readonly sentAt: number };

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
                      lastEndedCommandId: turn.lastEndedCommandId,
                  };
        case "running":
            return {
                kind: "current",
                commandId: decodeIdentifier(event.commandId),
                turnId: decodeIdentifier(event.turnId),
                startedAt: isCurrent(turn, event.commandId) ? turn.startedAt : event.startedAt,
                lastEndedCommandId: turn.lastEndedCommandId,
            };
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
        case "sent-at-known":
            return isCurrent(turn, event.commandId) ? { ...turn, startedAt: event.sentAt } : turn;
    }
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
        delivery.kind === "preparing" && delivery.message.target.disposition === "reject"
            ? delivery.message.commandId
            : delivery.kind === "submitting" && delivery.journal.request.disposition === "reject"
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
    if (delivery.kind === "preparation-failed" && delivery.message.target.disposition === "reject") {
        return { kind: "failed", commandId: delivery.message.commandId, ...delivery.failure };
    }
    return turn.failure === null ? { kind: "idle" } : { kind: "failed", ...turn.failure };
}
