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

/**
 * What a Session shows once the Runtime reports it idle. A failed turn stays marked until the next turn starts, and a
 * reply that finished while another Session was selected is unread.
 */
function settleIdle(current: ConversationListStatus | undefined, selected: boolean): ConversationListStatus {
    if (current?.kind === "failed") {
        return current;
    }
    if (!selected && (current?.kind === "working" || current?.kind === "unread")) {
        return { kind: "unread" };
    }
    return { kind: "idle" };
}

/**
 * What the sidebar shows for a Session. The open Session's pane owns its current turn and its delivery, including
 * submissions the Runtime never saw, so once the pane has reached the Runtime that Session's status is the pane's
 * activity. Every other Session shows what this store retained, or the status its directory entry was listed with.
 */
export function conversationListStatus(
    session: Pick<ManagedChatSession, "id" | "status">,
    statuses: ReadonlyMap<string, ConversationListStatus>,
    open: {
        readonly sessionId: string;
        readonly pane: Pick<SessionPaneStore, "connection" | "turn">;
        readonly delivery: DeliveryState;
    } | null,
): ConversationListStatus {
    return open?.sessionId === session.id && open.pane.connection.kind !== "first-loading"
        ? sessionActivity(open.pane.turn, open.delivery)
        : (statuses.get(session.id) ?? session.status);
}

interface ConversationStatusState {
    readonly statuses: ReadonlyMap<string, ConversationListStatus>;
    /** A directory load starts; its snapshot will not replace statuses that change after this. */
    readonly directoryLoadStarted: () => void;
    readonly directoryLoaded: (botId: string, sessions: readonly ManagedChatSession[], signal: AbortSignal) => void;
    /** The user opened this Session, so nothing it finished is unread. */
    readonly opened: (sessionId: string) => void;
    /**
     * The open pane of this Session stopped with `activity` as its last account. A failed turn, which only the pane
     * knows, stays marked until the next turn starts; whether the Session works is the Runtime's to report.
     */
    readonly paneReleased: (sessionId: string, activity: SessionActivityState) => void;
    /**
     * Whether Sessions have statuses but no stream follows them: the last one gave up, as when the Runtime went away.
     */
    readonly unfollowed: () => boolean;
    /** Follows the listed Sessions' statuses again after their stream gave up, from a fresh snapshot. */
    readonly follow: (signal: AbortSignal) => void;
    readonly close: () => void;
}

type ConversationStatusRequests = Pick<BotChatApi, "managedSessions" | "subscribeManagedSessionStatuses">;

export function createConversationStatusStore(
    requests: ConversationStatusRequests,
    /** The Session the user has open, read from the selection itself. */
    selectedSessionId: () => string | null,
    /** Announced when the Runtime closes a Session, with the reason it gives. */
    onSessionClosed: (sessionId: string, reason: string) => void,
    /** Announced when the stream following the Sessions gives up, as when the Runtime went away. */
    onUnfollowed: () => void,
    /** Announced when the stream reaches the Runtime and follows the Sessions again. */
    onFollowing: () => void,
) {
    let watcher: {
        readonly botId: string;
        readonly directoryKey: string;
        readonly controller: AbortController;
    } | null = null;
    let activeBotId = "";
    // The stream and the open pane report changes as they happen, while a directory snapshot describes the moment its
    // request was served. Each change is numbered so that a snapshot keeps the statuses that changed after it started.
    let changes = 0;
    const changedAt = new Map<string, number>();
    let directorySnapshotStartedAt = 0;

    const store = createStore<ConversationStatusState>((set, get) => {
        const replaceStatus = (sessionId: string, status: ConversationListStatus): void => {
            changes += 1;
            changedAt.set(sessionId, changes);
            set((state) => ({ statuses: new Map(state.statuses).set(sessionId, status) }));
        };
        const markCompleted = (sessionId: string): void => {
            replaceStatus(sessionId, settleIdle(get().statuses.get(sessionId), sessionId === selectedSessionId()));
        };

        const replaceDirectory = (sessions: readonly ManagedChatSession[], snapshotStartedAt: number): void => {
            set((state) => {
                const entries = sessions.map((session): readonly [string, ConversationListStatus] => {
                    const current = state.statuses.get(session.id);
                    if (current !== undefined && (changedAt.get(session.id) ?? 0) > snapshotStartedAt) {
                        return [session.id, current];
                    }
                    return [
                        session.id,
                        session.status.kind === "idle"
                            ? settleIdle(current, session.id === selectedSessionId())
                            : session.status,
                    ];
                });
                return { statuses: new Map(entries) };
            });
        };

        const closeWatcher = (): void => {
            watcher?.controller.abort(new Error("Conversation status watcher closed"));
            watcher = null;
        };

        /**
         * Follows the Sessions' statuses. The stream reports changes only, so following that resumes after a gap first
         * reads a snapshot, as every recovery inside the stream does.
         */
        const watch = (
            botId: string,
            sessionIds: readonly string[],
            parent: AbortSignal,
            start: "current" | "after-gap" = "current",
        ): void => {
            const directoryKey = JSON.stringify([...sessionIds].sort());
            if ((watcher?.botId === botId && watcher.directoryKey === directoryKey) || parent.aborted) {
                return;
            }
            closeWatcher();
            const controller = new AbortController();
            watcher = { botId, directoryKey, controller };
            const signal = AbortSignal.any([parent, controller.signal]);
            void (async () => {
                let recoveries = 0;
                let snapshotNeeded = start === "after-gap";
                try {
                    while (!signal.aborted) {
                        try {
                            if (snapshotNeeded) {
                                const snapshotStartedAt = changes;
                                replaceDirectory(await requests.managedSessions(botId, signal), snapshotStartedAt);
                                snapshotNeeded = false;
                            }
                            await requests.subscribeManagedSessionStatuses(
                                botId,
                                (event) => {
                                    // Opening the stream shows it works, but only a Session event shows it keeps working,
                                    // so only that restores the stream's own retries.
                                    if (event.kind === "managed-session.statuses.following") {
                                        onFollowing();
                                        return;
                                    }
                                    recoveries = 0;
                                    if (event.kind === "session.close.notice") {
                                        onSessionClosed(event.sessionId, event.reason);
                                    } else if (event.status.kind === "idle") {
                                        markCompleted(event.sessionId);
                                    } else {
                                        replaceStatus(event.sessionId, event.status);
                                    }
                                },
                                signal,
                            );
                            signal.throwIfAborted();
                            throw new Error("Conversation status stream ended");
                        } catch (cause) {
                            signal.throwIfAborted();
                            if (recoveries >= 2) {
                                throw cause;
                            }
                            recoveries += 1;
                            snapshotNeeded = true;
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
            statuses: new Map(),
            directoryLoadStarted: () => {
                directorySnapshotStartedAt = changes;
            },
            directoryLoaded: (botId, sessions, signal) => {
                if (activeBotId !== botId) {
                    closeWatcher();
                    activeBotId = botId;
                }
                replaceDirectory(sessions, directorySnapshotStartedAt);
                if (sessions.length > 0) {
                    watch(
                        botId,
                        sessions.map((session) => session.id),
                        signal,
                    );
                }
            },
            opened: (sessionId) => {
                if (get().statuses.get(sessionId)?.kind === "unread") {
                    replaceStatus(sessionId, { kind: "idle" });
                }
            },
            paneReleased: (sessionId, activity) => {
                switch (activity.kind) {
                    case "failed":
                        replaceStatus(sessionId, activity);
                        return;
                    case "idle":
                        // The pane saw the failure it had marked resolved.
                        if (get().statuses.get(sessionId)?.kind === "failed") {
                            replaceStatus(sessionId, { kind: "idle" });
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
                    watch(activeBotId, [...get().statuses.keys()], signal, "after-gap");
                }
            },
            close: closeWatcher,
        };
    });

    return store;
}
