import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { DeliveryState } from "./session-delivery-store.ts";

// The turn the Session pane treats as current. It is the one record of which command runs, how far the service
// confirmed it and when it started. The working indicator, the stop control and the status the pane reports are all
// derived from it, so they cannot disagree. A submission that fails before the service accepts it ran no turn: its
// failure belongs to the Session's delivery.

export type TurnFailure = { readonly code: string; readonly message: string };

type TurnSubmission =
    /** The command is current, but this pane has not submitted it, as when it retries an unconfirmed delivery. */
    | { readonly kind: "unconfirmed" }
    | { readonly kind: "submitting" }
    | { readonly kind: "accepted"; readonly turnId: string };

export type CurrentTurn = {
    /** The last Runtime terminal outcome observed, retained when a local submission clears its failure. */
    readonly lastEndedCommandId: string | null;
} & (
    | {
          readonly kind: "idle";
          /** The last failure the service reported for a turn, reported until another turn starts. */
          readonly failure: (TurnFailure & { readonly commandId: string }) | null;
      }
    | {
          readonly kind: "current";
          readonly commandId: string;
          readonly startedAt: number;
          readonly submission: TurnSubmission;
      }
);

export type CurrentTurnEvent =
    /** This pane submits a new command. */
    | { readonly kind: "submitting"; readonly commandId: string; readonly startedAt: number }
    /** This pane submits an unconfirmed command again. */
    | { readonly kind: "retrying"; readonly commandId: string; readonly startedAt: number }
    /** The service accepted this pane's submission of the command. */
    | { readonly kind: "accepted"; readonly commandId: string; readonly turnId: string }
    /** The service reports the command running; it replaces any other current command. */
    | { readonly kind: "running"; readonly commandId: string; readonly turnId: string; readonly startedAt: number }
    /** The service reports the command's turn ended; `failure` explains a failed one. */
    | { readonly kind: "ended"; readonly commandId: string; readonly failure: TurnFailure | null }
    /**
     * This pane's submission of the command ended without the service accepting it in reply: it was refused, its
     * delivery is uncertain, failed or was discarded, or only an event showed the service has it. Whether the
     * command's turn runs is the service's to report, so this ends only a turn the service has not reported running.
     */
    | { readonly kind: "submission-ended"; readonly commandId: string }
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
        startedAt: running.startedAt,
        submission: { kind: "accepted", turnId: decodeIdentifier(running.turnId) },
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
        case "submitting":
            return {
                kind: "current",
                commandId: event.commandId,
                startedAt: event.startedAt,
                submission: { kind: "submitting" },
                lastEndedCommandId: turn.lastEndedCommandId,
            };
        case "retrying":
            // Retrying a submission cannot displace a turn the service reports running.
            if (turn.kind === "current" && turn.submission.kind === "accepted" && turn.commandId !== event.commandId) {
                return turn;
            }
            return {
                kind: "current",
                commandId: event.commandId,
                startedAt: event.startedAt,
                submission: isCurrent(turn, event.commandId) ? turn.submission : { kind: "unconfirmed" },
                lastEndedCommandId: turn.lastEndedCommandId,
            };
        case "accepted":
            // A terminal live event can precede the acceptance response; the turn it ended stays ended.
            return isCurrent(turn, event.commandId)
                ? { ...turn, submission: { kind: "accepted", turnId: decodeIdentifier(event.turnId) } }
                : turn;
        case "running":
            return {
                kind: "current",
                commandId: decodeIdentifier(event.commandId),
                startedAt: isCurrent(turn, event.commandId) ? turn.startedAt : event.startedAt,
                submission: { kind: "accepted", turnId: decodeIdentifier(event.turnId) },
                lastEndedCommandId: turn.lastEndedCommandId,
            };
        case "ended":
            return isCurrent(turn, event.commandId) ? endedTurn(event.commandId, event.failure, event.commandId) : turn;
        case "submission-ended":
            // The service's report that the command runs outranks this pane's account of its submission.
            return isCurrent(turn, event.commandId) && turn.submission.kind !== "accepted"
                ? endedTurn(event.commandId, null, turn.lastEndedCommandId)
                : turn;
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
    return turn.kind === "current" && turn.submission.kind === "accepted"
        ? { commandId: turn.commandId, turnId: turn.submission.turnId }
        : null;
}

/** The command this pane is submitting and the service has not yet accepted. */
export function submittingCommandId(turn: CurrentTurn): string | null {
    return turn.kind === "current" && turn.submission.kind === "submitting" ? turn.commandId : null;
}

/** Whether a reconnect that finds no running turn must end this one: only a submitted command can have ended. */
export function awaitsService(turn: CurrentTurn): boolean {
    return turn.kind === "current" && turn.submission.kind !== "unconfirmed";
}

/**
 * What the pane reports for the Session: working while a command is current; otherwise failed while a message that
 * would have started a turn keeps the failure of its preparation, or after the service reported a failed turn;
 * otherwise idle. A message the service rejected reports its failure on the message alone.
 */
export function sessionActivity(turn: CurrentTurn, delivery: DeliveryState): SessionActivityState {
    if (turn.kind === "current") {
        return { kind: "working", commandId: turn.commandId, startedAt: turn.startedAt };
    }
    if (delivery.kind === "preparation-failed" && delivery.message.target.disposition === "reject") {
        return { kind: "failed", commandId: delivery.message.commandId, ...delivery.failure };
    }
    return turn.failure === null ? { kind: "idle" } : { kind: "failed", ...turn.failure };
}
