import type { SessionLastSentMessage } from "../../services/indexed-db/central-indexed-db.ts";

// What this browser sent in the Session: the queued first message's command until a send claims it, and the latest
// message it sent, which dates the work that message started. Which turn is current is `session-current-turn.ts`'s.

interface SessionTurnLedgerState {
    /** The queued first message's command id until a send claims it. */
    readonly initialCommandId: string | null;
    /** The latest message this browser sent, for the working timer's start. */
    readonly lastSent: SessionLastSentMessage | null;
    /** Counts local sends so a slower read of the stored send cannot replace a newer one. */
    readonly lastSentRevision: number;
}

export function createSessionTurnLedger(options: { readonly initialCommandId: string | null }) {
    let state: SessionTurnLedgerState = {
        initialCommandId: options.initialCommandId,
        lastSent: null,
        lastSentRevision: 0,
    };
    return {
        /** Whether the queued first message still waits for its send. */
        hasInitialCommand: (): boolean => state.initialCommandId !== null,
        /** The next send's command: the queued first message's command, or `generated`. */
        claimCommand: (generated: string): string => {
            const commandId = state.initialCommandId ?? generated;
            state = { ...state, initialCommandId: null };
            return commandId;
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
