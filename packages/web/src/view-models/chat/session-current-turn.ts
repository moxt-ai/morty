import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionActivityState } from "./session-activity-machine.ts";

// The turn the Session pane treats as current. It is the one record of which command runs, how far the service
// confirmed it and when it started. The working indicator, the stop control and the status the pane reports are all
// derived from it, so they cannot disagree.

type TurnSubmission =
    /** The command is current, but this pane has not submitted it, as when it retries an unconfirmed delivery. */
    | { readonly kind: "unconfirmed" }
    | { readonly kind: "submitting" }
    | { readonly kind: "accepted"; readonly turnId: string };

export type CurrentTurn =
    | {
          readonly kind: "idle";
          /** The last turn's failure, reported until another turn starts. */
          readonly failure: { readonly commandId: string; readonly message: string } | null;
      }
    | {
          readonly kind: "current";
          readonly commandId: string;
          readonly startedAt: number;
          readonly submission: TurnSubmission;
      };

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
    | { readonly kind: "ended"; readonly commandId: string; readonly failure: string | null }
    /**
     * This pane gave up submitting the command: the service refused it, or its delivery is uncertain or failed.
     * `failure` explains a failed submission.
     */
    | { readonly kind: "submission-abandoned"; readonly commandId: string; readonly failure: string | null }
    /** Nothing runs any more, as when the Session closed or a reconnect found no running turn. */
    | { readonly kind: "nothing-running" }
    /** This browser sent the command at `sentAt`, which is when its work started. */
    | { readonly kind: "sent-at-known"; readonly commandId: string; readonly sentAt: number };

export const idleTurn: CurrentTurn = { kind: "idle", failure: null };

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
    };
}

function isCurrent(turn: CurrentTurn, commandId: string): turn is Extract<CurrentTurn, { readonly kind: "current" }> {
    return turn.kind === "current" && turn.commandId === commandId;
}

function endedTurn(commandId: string, failure: string | null): CurrentTurn {
    return { kind: "idle", failure: failure === null ? null : { commandId, message: failure } };
}

export function transitionCurrentTurn(turn: CurrentTurn, event: CurrentTurnEvent): CurrentTurn {
    switch (event.kind) {
        case "submitting":
            return {
                kind: "current",
                commandId: event.commandId,
                startedAt: event.startedAt,
                submission: { kind: "submitting" },
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
            };
        case "ended":
            return isCurrent(turn, event.commandId) ? endedTurn(event.commandId, event.failure) : turn;
        case "submission-abandoned":
            // The service's report that the command runs outranks this pane's account of its submission.
            return isCurrent(turn, event.commandId) && turn.submission.kind !== "accepted"
                ? endedTurn(event.commandId, event.failure)
                : turn;
        case "nothing-running":
            // Learning that nothing runs cannot resolve an earlier turn failure.
            return turn.kind === "idle" ? turn : idleTurn;
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

/** Whether a reconnect that finds no running turn must end this one: only a submitted command can have ended. */
export function awaitsService(turn: CurrentTurn): boolean {
    return turn.kind === "current" && turn.submission.kind !== "unconfirmed";
}

/** What the pane reports: working while a command is current, failed after a failed turn, otherwise idle. */
export function turnActivity(turn: CurrentTurn): SessionActivityState {
    switch (turn.kind) {
        case "current":
            return { kind: "working", commandId: turn.commandId, startedAt: turn.startedAt };
        case "idle":
            return turn.failure === null
                ? { kind: "idle" }
                : { kind: "failed", commandId: turn.failure.commandId, message: turn.failure.message };
    }
}
