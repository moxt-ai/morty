import { NativeSessionMap, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";
import { sessionActivity } from "./session-current-turn.ts";
import type { DeliveryState } from "./session-delivery-store.ts";
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
 * What the sidebar shows for a Session. The open Session's pane owns its current turn and its delivery, including
 * submissions the Runtime never saw, so once the pane has reached the Runtime that Session's status is the pane's
 * activity. Every other Session shows what this store retained, or the status its directory entry was listed with.
 */
export function conversationListStatus(
    session: Pick<ManagedChatSession, "target" | "status">,
    statuses: Pick<NativeSessionMap<ConversationListStatus>, "get">,
    open: {
        readonly sessionTarget: NativeSessionTarget;
        readonly pane: Pick<SessionPaneStore, "connection" | "turn">;
        readonly delivery: DeliveryState;
    } | null,
): ConversationListStatus {
    return open !== null &&
        sameNativeSession(open.sessionTarget, session.target) &&
        open.pane.connection.kind !== "first-loading"
        ? sessionActivity(open.pane.turn, open.delivery)
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
    readonly directoryLoaded: (
        computerId: string,
        sessions: readonly ManagedChatSession[],
        signal: AbortSignal,
    ) => void;
    /** The user opened this Session, so nothing it finished is unread. */
    readonly opened: (sessionTarget: NativeSessionTarget) => void;
    /**
     * The open pane stopped with `activity` as its last account. Retain it until the Runtime reports current status.
     */
    readonly paneReleased: (sessionTarget: NativeSessionTarget, activity: SessionActivityState) => void;
    /**
     * Whether Sessions have statuses but no stream follows them: the last one gave up, as when the Runtime went away.
     */
    readonly unfollowed: () => boolean;
    /** Follows the Sessions' statuses again after their stream gave up. */
    readonly follow: (signal: AbortSignal) => void;
    readonly close: () => void;
}

type ConversationStatusRequests = Pick<BotChatApi, "managedSessions" | "subscribeManagedSessionStatuses">;

export function createConversationStatusStore(
    requests: ConversationStatusRequests,
    /** The Session the user has open, read from the selection itself. */
    selectedSessionId: () => NativeSessionTarget | null,
    /** Announced when the Runtime closes a Session, with the reason it gives. */
    onSessionClosed: (sessionTarget: NativeSessionTarget, reason: string) => void,
    /** Announced when the stream following the Sessions gives up, as when the Runtime went away. */
    onUnfollowed: () => void,
    /** Announced when the stream reaches the Runtime and follows the Sessions again. */
    onFollowing: () => void,
) {
    let watcher: {
        readonly computerId: string;
        readonly controller: AbortController;
    } | null = null;
    let activeComputerId = "";
    // The stream and the open pane report changes as they happen, while a directory snapshot describes the moment its
    // request was served. Each change is numbered so that a snapshot keeps the statuses that changed after it started.
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
        const markCompleted = (sessionTarget: NativeSessionTarget, status: IdleStatus): void => {
            replaceStatus(
                sessionTarget,
                settleIdle(get().statuses.get(sessionTarget), selected(sessionTarget), status),
            );
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

        /**
         * Each following snapshot is authoritative in this stream's order, including after transport reconnection.
         * The stream sends it before subsequent changes. Only independent directory reads need the change counter:
         * capturing a counter when this long-lived subscription starts would reject future reconnect snapshots.
         */
        const applyCurrentStatuses = (
            statuses: readonly {
                readonly target: NativeSessionTarget;
                readonly status: ManagedChatSession["status"];
            }[],
        ): void => {
            for (const { target: sessionTarget, status } of statuses) {
                if (status.kind === "idle") {
                    markCompleted(sessionTarget, status);
                } else {
                    replaceStatus(sessionTarget, status);
                }
            }
        };

        const closeWatcher = (): void => {
            watcher?.controller.abort(new Error("Conversation status watcher closed"));
            watcher = null;
        };

        /**
         * Follows the Sessions' statuses. Each time the stream follows, it reports their current statuses with that
         * notice, before their changes, so a gap before it needs no snapshot of its own.
         */
        const watch = (computerId: string, parent: AbortSignal): void => {
            if (watcher?.computerId === computerId || parent.aborted) {
                return;
            }
            closeWatcher();
            const controller = new AbortController();
            watcher = { computerId, controller };
            const signal = AbortSignal.any([parent, controller.signal]);
            void (async () => {
                let recoveries = 0;
                try {
                    while (!signal.aborted) {
                        try {
                            await requests.subscribeManagedSessionStatuses((event) => {
                                // Opening the stream shows it works, but only a later Session event shows it keeps
                                // working, so only that restores the stream's own retries.
                                if (event.kind === "managed-session.statuses.following") {
                                    applyCurrentStatuses(event.statuses);
                                    onFollowing();
                                    return;
                                }
                                recoveries = 0;
                                if (event.kind === "session.close.notice") {
                                    onSessionClosed(event.target, event.reason);
                                } else if (event.status.kind === "idle") {
                                    markCompleted(event.target, event.status);
                                } else {
                                    replaceStatus(event.target, event.status);
                                }
                            }, signal);
                            signal.throwIfAborted();
                            throw new Error("Conversation status stream ended");
                        } catch (cause) {
                            signal.throwIfAborted();
                            if (recoveries >= 2) {
                                throw cause;
                            }
                            recoveries += 1;
                        }
                    }
                } catch (cause) {
                    if (!signal.aborted) {
                        console.error("Conversation status updates disconnected", cause);
                    }
                } finally {
                    if (watcher?.controller === controller) {
                        watcher = null;
                        if (!signal.aborted) {
                            onUnfollowed();
                        }
                    }
                }
            })();
        };

        return {
            statuses: new NativeSessionMap(),
            directoryLoadStarted: () => {
                directorySnapshotStartedAt = changes;
            },
            directoryLoaded: (computerId, sessions, signal) => {
                if (activeComputerId !== computerId) {
                    closeWatcher();
                    activeComputerId = computerId;
                }
                replaceDirectory(sessions, directorySnapshotStartedAt);
                if (sessions.length > 0) {
                    watch(computerId, signal);
                }
            },
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
                        return;
                    default:
                        return activity satisfies never;
                }
            },
            unfollowed: () => watcher === null && get().statuses.size > 0,
            follow: (signal) => {
                if (watcher === null && get().statuses.size > 0) {
                    watch(activeComputerId, signal);
                }
            },
            close: closeWatcher,
        };
    });

    return store;
}
