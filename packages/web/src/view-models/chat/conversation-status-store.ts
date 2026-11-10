import { NativeSessionMap, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { DeliveryState } from "./session-delivery-store.ts";
import { type SessionExecutionState, sessionActivity } from "./session-execution.ts";
import type { SessionPaneStore } from "./session-pane-store.ts";

export type ConversationStatusStoreApi = ReturnType<typeof createConversationStatusStore>;

export type ConversationListStatus =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "working" }
    | { readonly kind: "failed"; readonly commandId: string | null; readonly message: string }
    | { readonly kind: "unread" };

/** What an idle status says about the Session's last turn, from the Chat Worker's listing or the Runtime's stream. */
type IdleStatus = {
    readonly failedTurn?: { readonly commandId: string; readonly message: string } | undefined;
};

/**
 * What a Session shows once the Runtime reports it idle. A reply that finished while another Session was selected is
 * unread. The Runtime owns the last turn outcome, including the absence of failure after a later successful turn.
 */
function settleIdle(
    current: ConversationListStatus | undefined,
    selected: boolean,
    status: IdleStatus,
): ConversationListStatus {
    if (!selected && (current?.kind === "working" || current?.kind === "unread")) {
        return { kind: "unread" };
    }
    if (status.failedTurn !== undefined) {
        return { kind: "failed", commandId: status.failedTurn.commandId, message: status.failedTurn.message };
    }
    return { kind: "idle" };
}

/**
 * What the sidebar shows for a Session. The open Session's execution and delivery, including submissions the Runtime
 * never saw, are followed by its pane, so once the pane has reached the Runtime that Session's status is their
 * activity. Every other Session shows what this store retained, or the status its directory entry was listed with.
 */
export function conversationListStatus(
    session: Pick<ManagedChatSession, "target" | "status">,
    statuses: Pick<NativeSessionMap<ConversationListStatus>, "get">,
    open: {
        readonly sessionTarget: NativeSessionTarget;
        readonly pane: Pick<SessionPaneStore, "connection">;
        readonly execution: Pick<SessionExecutionState, "turn" | "commands">;
        readonly delivery: DeliveryState;
    } | null,
): ConversationListStatus {
    return open !== null &&
        sameNativeSession(open.sessionTarget, session.target) &&
        open.pane.connection.kind !== "first-loading"
        ? sessionActivity(open.execution, open.delivery)
        : (statuses.get(session.target) ?? session.status);
}

/** Whether any listed Session holds a reply the user has not seen, as the collapsed mobile header must say. */
export function hasUnreadConversation(
    sessions: readonly Pick<ManagedChatSession, "target" | "status">[] | null,
    statuses: Pick<NativeSessionMap<ConversationListStatus>, "get">,
    open: Parameters<typeof conversationListStatus>[2],
): boolean {
    return (sessions ?? []).some((session) => conversationListStatus(session, statuses, open).kind === "unread");
}

interface ConversationStatusState {
    readonly statuses: NativeSessionMap<ConversationListStatus>;
    /** A directory load starts; its snapshot will not replace statuses that change after this. */
    readonly directoryLoadStarted: () => void;
    readonly directoryLoaded: (sessions: readonly ManagedChatSession[]) => void;
    /** The user opened this Session, so nothing it finished is unread. */
    readonly opened: (sessionTarget: NativeSessionTarget) => void;
    /**
     * The open pane stopped with `activity` as its last account. Retain it until the Runtime reports current status.
     */
    readonly paneReleased: (sessionTarget: NativeSessionTarget, activity: SessionActivityState) => void;
}

export function createConversationStatusStore(selectedSessionId: () => NativeSessionTarget | null) {
    let changes = 0;
    const changedAt = new NativeSessionMap<number>();
    const selected = (target: NativeSessionTarget): boolean => {
        const current = selectedSessionId();
        return current !== null && sameNativeSession(current, target);
    };
    let directorySnapshotStartedAt = 0;

    const store = createStore<ConversationStatusState>((set, get) => {
        const replaceStatus = (sessionTarget: NativeSessionTarget, status: ConversationListStatus): void => {
            changes += 1;
            changedAt.set(sessionTarget, changes);
            set((state) => ({ statuses: new NativeSessionMap(state.statuses).set(sessionTarget, status) }));
        };
        const replaceDirectory = (sessions: readonly ManagedChatSession[], snapshotStartedAt: number): void => {
            set((state) => {
                const entries = sessions.map((session): readonly [NativeSessionTarget, ConversationListStatus] => {
                    const current = state.statuses.get(session.target);
                    if (current !== undefined && (changedAt.get(session.target) ?? 0) > snapshotStartedAt) {
                        return [session.target, current];
                    }
                    return [
                        session.target,
                        session.status.kind === "idle"
                            ? settleIdle(current, selected(session.target), session.status)
                            : session.status,
                    ];
                });
                return { statuses: new NativeSessionMap(entries) };
            });
        };

        return {
            statuses: new NativeSessionMap(),
            directoryLoadStarted: () => {
                directorySnapshotStartedAt = changes;
            },
            directoryLoaded: (sessions) => replaceDirectory(sessions, directorySnapshotStartedAt),
            opened: (sessionTarget) => {
                if (get().statuses.get(sessionTarget)?.kind === "unread") {
                    replaceStatus(sessionTarget, { kind: "idle" });
                }
            },
            paneReleased: (sessionTarget, activity) => {
                switch (activity.kind) {
                    case "failed":
                        replaceStatus(sessionTarget, activity);
                        return;
                    case "idle":
                        // The pane saw the failure it had marked resolved.
                        if (get().statuses.get(sessionTarget)?.kind === "failed") {
                            replaceStatus(sessionTarget, { kind: "idle" });
                        }
                        return;
                    case "working":
                        replaceStatus(sessionTarget, activity);
                        return;
                    default:
                        return activity satisfies never;
                }
            },
        };
    });

    return store;
}
