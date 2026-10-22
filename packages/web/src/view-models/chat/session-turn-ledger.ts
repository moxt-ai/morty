import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionLastSentMessage } from "../../services/indexed-db/central-indexed-db.ts";

// Which turn the Session pane treats as current. The pane's workflows change
// these values only through the transitions below, so every rule about the
// current command, its service-side turn and its start time lives here.

export type SessionActiveTurn =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "submitting" }
    | { readonly commandId: string; readonly kind: "accepted"; readonly turnId: string };

interface SessionTurnLedgerState {
    /**
     * The command this pane treats as its current turn. It can name a command the
     * service has not confirmed yet, so it is tracked apart from `activeTurn`.
     */
    readonly command: string | null;
    /** The service-side turn this pane has confirmed or is submitting. */
    readonly activeTurn: SessionActiveTurn;
    /** The queued first message's command id until a send claims it. */
    readonly initialCommandId: string | null;
    /** The latest message this browser sent, for the working timer's start. */
    readonly lastSent: SessionLastSentMessage | null;
    /** Counts local sends so a slower read of the stored send cannot replace a newer one. */
    readonly lastSentRevision: number;
}

function acceptedTurn(commandId: string, turnId: string): SessionActiveTurn {
    return { commandId: decodeIdentifier(commandId), kind: "accepted", turnId: decodeIdentifier(turnId) };
}

function clearTurn(turn: SessionActiveTurn, commandId: string): SessionActiveTurn {
    return turn.kind !== "idle" && turn.commandId === commandId ? { kind: "idle" } : turn;
}

export function createSessionTurnLedger(options: {
    readonly opened: SessionActiveTurn;
    readonly initialCommandId: string | null;
}) {
    let state: SessionTurnLedgerState = {
        command: options.opened.kind === "idle" ? null : options.opened.commandId,
        activeTurn: options.opened,
        initialCommandId: options.initialCommandId,
        lastSent: null,
        lastSentRevision: 0,
    };
    return {
        command: (): string | null => state.command,
        activeTurn: (): SessionActiveTurn => state.activeTurn,
        /** Whether the queued first message still waits for its send. */
        hasInitialCommand: (): boolean => state.initialCommandId !== null,
        /** Makes the next send current: the queued first message's command, or `generated`. */
        claimCommand: (generated: string): string => {
            const commandId = state.initialCommandId ?? generated;
            state = { ...state, command: commandId, initialCommandId: null };
            return commandId;
        },
        setCommand: (commandId: string): void => {
            state = { ...state, command: commandId };
        },
        /** Makes a running turn the current one. */
        adoptRunning: (commandId: string, turnId: string): void => {
            state = { ...state, command: commandId };
            state = { ...state, activeTurn: acceptedTurn(commandId, turnId) };
        },
        submissionStarted: (commandId: string): void => {
            state = { ...state, activeTurn: { commandId: decodeIdentifier(commandId), kind: "submitting" } };
        },
        submissionAccepted: (commandId: string, turnId: string): void => {
            state = { ...state, activeTurn: acceptedTurn(commandId, turnId) };
        },
        /**
         * Another command started: clears the current command's turn and returns the
         * superseded command, or null when `commandId` is already current or none is.
         */
        supersede: (commandId: string): string | null => {
            const previous = state.command;
            if (previous === null || previous === commandId) {
                return null;
            }
            state = { ...state, activeTurn: clearTurn(state.activeTurn, previous) };
            return previous;
        },
        /** The command's turn ended; it stops being current if it was. */
        release: (commandId: string): void => {
            state = {
                ...state,
                activeTurn: clearTurn(state.activeTurn, commandId),
                command: state.command === commandId ? null : state.command,
            };
        },
        /** Drops the command only when it is the current one. */
        discard: (commandId: string): void => {
            if (state.command === commandId) {
                state = { ...state, activeTurn: clearTurn(state.activeTurn, commandId), command: null };
            }
        },
        /** The Runtime reports no running turn: clears `commandId`'s turn and any current command. */
        abandon: (commandId: string): void => {
            state = { ...state, activeTurn: clearTurn(state.activeTurn, commandId), command: null };
        },
        /** Nothing runs any more, as when the Session closed. */
        settleIdle: (): void => {
            state = { ...state, activeTurn: { kind: "idle" }, command: null };
        },
        /** Records a message this browser just sent; the caller persists the returned record. */
        recordSent: (commandId: string, sentAt: number): SessionLastSentMessage => {
            const lastSent = { commandId, sentAt };
            state = { ...state, lastSent, lastSentRevision: state.lastSentRevision + 1 };
            return lastSent;
        },
        lastSentRevision: (): number => state.lastSentRevision,
        /** Adopts a stored send unless this browser sent again after `revision`. */
        adoptStoredSent: (stored: SessionLastSentMessage, revision: number): boolean => {
            if (revision !== state.lastSentRevision) {
                return false;
            }
            state = { ...state, lastSent: stored };
            return true;
        },
        /** When `commandId` started, if this browser sent it, otherwise `fallback`. */
        startedAt: (commandId: string, fallback: number): number =>
            state.lastSent?.commandId === commandId ? state.lastSent.sentAt : fallback,
    } as const;
}
