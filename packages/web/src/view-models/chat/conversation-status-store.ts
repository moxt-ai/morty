import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";

export type ConversationStatusStoreApi = ReturnType<typeof createConversationStatusStore>;

export type ConversationListStatus =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "working" }
    | { readonly kind: "failed"; readonly commandId: string | null; readonly message: string }
    | { readonly kind: "unread" };

interface ConversationStatusState {
    readonly statuses: ReadonlyMap<string, ConversationListStatus>;
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

    const store = createStore<ConversationStatusState>((set, get) => {
        const replaceStatus = (sessionId: string, status: ConversationListStatus): void => {
            set((state) => ({ statuses: new Map(state.statuses).set(sessionId, status) }));
        };
        const markCompleted = (sessionId: string): void => {
            set((state) => {
                const current = state.statuses.get(sessionId);
                return {
                    statuses: new Map(state.statuses).set(
                        sessionId,
                        sessionId !== selectedSessionId && (current?.kind === "working" || current?.kind === "unread")
                            ? { kind: "unread" }
                            : { kind: "idle" },
                    ),
                };
            });
        };

        const replaceDirectory = (sessions: readonly ManagedChatSession[]): void => {
            set((state) => {
                const entries = sessions.map((session): readonly [string, ConversationListStatus] => {
                    const current = state.statuses.get(session.id);
                    if (
                        session.status.kind === "idle" &&
                        session.id !== selectedSessionId &&
                        (current?.kind === "working" || current?.kind === "unread")
                    ) {
                        return [session.id, { kind: "unread" }];
                    }
                    return [session.id, session.status];
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
                            replaceDirectory(await requests.managedSessions(botId, signal));
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
            directoryLoaded: (botId, sessions, signal) => {
                if (activeBotId !== botId) {
                    closeWatcher();
                    activeBotId = botId;
                }
                replaceDirectory(sessions);
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
                if (sessionId !== null) {
                    set((state) => {
                        if (state.statuses.get(sessionId)?.kind !== "unread") {
                            return state;
                        }
                        return { statuses: new Map(state.statuses).set(sessionId, { kind: "idle" }) };
                    });
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
