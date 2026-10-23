import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";

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

interface ConversationStatusState {
    readonly statuses: ReadonlyMap<string, ConversationListStatus>;
    /** A directory load starts; its snapshot will not replace statuses that change after this. */
    readonly directoryLoadStarted: () => void;
    readonly directoryLoaded: (botId: string, sessions: readonly ManagedChatSession[], signal: AbortSignal) => void;
    readonly selectionChanged: (sessionId: string | null) => void;
    readonly statusChanged: (
        botId: string,
        sessionId: string,
        status: SessionActivityState,
        signal: AbortSignal,
    ) => void;
    readonly close: () => void;
}

type ConversationStatusRequests = Pick<BotChatApi, "managedSessions" | "subscribeManagedSessionStatuses">;

export function createConversationStatusStore(
    requests: ConversationStatusRequests,
    /** Announced when the Runtime closes a Session, with the reason it gives. */
    onSessionClosed: (sessionId: string, reason: string) => void,
) {
    let watcher: {
        readonly botId: string;
        readonly directoryKey: string;
        readonly controller: AbortController;
    } | null = null;
    let activeBotId = "";
    let selectedSessionId: string | null = null;
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
            replaceStatus(sessionId, settleIdle(get().statuses.get(sessionId), sessionId === selectedSessionId));
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
                            ? settleIdle(current, session.id === selectedSessionId)
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

        const watch = (botId: string, sessionIds: readonly string[], parent: AbortSignal): void => {
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
                try {
                    while (!signal.aborted) {
                        try {
                            await requests.subscribeManagedSessionStatuses(
                                botId,
                                (event) => {
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
                            const snapshotStartedAt = changes;
                            replaceDirectory(await requests.managedSessions(botId, signal), snapshotStartedAt);
                        }
                    }
                } catch (cause) {
                    if (!signal.aborted) {
                        console.error("Conversation status updates disconnected", cause);
                    }
                } finally {
                    if (watcher?.controller === controller) {
                        watcher = null;
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
            selectionChanged: (sessionId) => {
                selectedSessionId = sessionId;
                if (sessionId !== null && get().statuses.get(sessionId)?.kind === "unread") {
                    replaceStatus(sessionId, { kind: "idle" });
                }
            },
            statusChanged: (botId, sessionId, status, signal) => {
                if (activeBotId !== botId) {
                    closeWatcher();
                    activeBotId = botId;
                    set({ statuses: new Map() });
                }
                replaceStatus(sessionId, status);
                watch(botId, [...get().statuses.keys()], signal);
            },
            close: closeWatcher,
        };
    });

    return store;
}
