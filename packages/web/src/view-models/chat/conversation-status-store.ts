import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";

export type ConversationListStatus = SessionActivityState | { readonly kind: "unread" };

interface ConversationStatusState {
    readonly statuses: ReadonlyMap<string, ConversationListStatus>;
    readonly directoryLoaded: (botId: string, sessions: readonly ManagedChatSession[], signal: AbortSignal) => void;
    readonly statusChanged: (
        botId: string,
        sessionId: string,
        status: SessionActivityState,
        signal: AbortSignal,
    ) => void;
    readonly close: () => void;
}

type ConversationStatusRequests = Pick<BotChatApi, "connectSession" | "managedSessions">;

export function createConversationStatusStore(requests: ConversationStatusRequests) {
    const watchers = new Map<string, AbortController>();
    let activeBotId = "";

    const store = createStore<ConversationStatusState>((set) => {
        const replaceStatus = (sessionId: string, status: ConversationListStatus): void => {
            set((state) => ({ statuses: new Map(state.statuses).set(sessionId, status) }));
        };
        const markCompleted = (sessionId: string): void => {
            set((state) => {
                const current = state.statuses.get(sessionId);
                return {
                    statuses: new Map(state.statuses).set(
                        sessionId,
                        current?.kind === "working" || current?.kind === "unread"
                            ? { kind: "unread" }
                            : { kind: "idle" },
                    ),
                };
            });
        };

        const closeWatchers = (): void => {
            for (const controller of watchers.values()) {
                controller.abort(new Error("Conversation status watcher closed"));
            }
            watchers.clear();
        };

        const watch = (botId: string, sessionId: string, parent: AbortSignal): void => {
            const key = `${botId}:${sessionId}`;
            if (watchers.has(key) || parent.aborted) {
                return;
            }
            const controller = new AbortController();
            watchers.set(key, controller);
            const signal = AbortSignal.any([parent, controller.signal]);
            void (async () => {
                let client: Awaited<ReturnType<ConversationStatusRequests["connectSession"]>> | null = null;
                const reconcile = async (): Promise<boolean> => {
                    const sessions = await requests.managedSessions(botId, signal);
                    signal.throwIfAborted();
                    const session = sessions.find((candidate) => candidate.id === sessionId);
                    if (session === undefined || session.status.kind === "idle") {
                        if (session !== undefined) {
                            markCompleted(sessionId);
                        }
                        return false;
                    }
                    replaceStatus(sessionId, session.status);
                    return true;
                };
                try {
                    client = await requests.connectSession(botId, sessionId, signal);
                    const subscription = await client.events.subscribeLiveV2(
                        sessionId,
                        {
                            reconcile: async () => {
                                if (!(await reconcile())) {
                                    controller.abort(new Error("Conversation is idle"));
                                }
                            },
                            receive: (event) => {
                                if (event.type === "acp") {
                                    return Promise.resolve(true);
                                }
                                const payload = event.payload;
                                if (payload.kind === "prompt.started") {
                                    replaceStatus(sessionId, {
                                        commandId: payload.commandId,
                                        kind: "working",
                                    });
                                    return Promise.resolve(true);
                                }
                                if (
                                    payload.kind === "prompt.completed" ||
                                    payload.kind === "prompt.failed" ||
                                    payload.kind === "prompt.failed-before-start"
                                ) {
                                    return reconcile();
                                }
                                return Promise.resolve(true);
                            },
                        },
                        signal,
                    );
                    await subscription.completed;
                } catch (cause) {
                    if (!signal.aborted) {
                        console.error("Conversation status updates disconnected", cause);
                    }
                } finally {
                    client?.close();
                    if (watchers.get(key) === controller) {
                        watchers.delete(key);
                    }
                }
            })();
        };

        return {
            statuses: new Map(),
            directoryLoaded: (botId, sessions, signal) => {
                if (activeBotId !== botId) {
                    closeWatchers();
                    activeBotId = botId;
                }
                set((state) => ({
                    statuses: new Map(
                        sessions.map((session) => [
                            session.id,
                            state.statuses.get(session.id)?.kind === "unread" && session.status.kind === "idle"
                                ? { kind: "unread" as const }
                                : session.status,
                        ]),
                    ),
                }));
                for (const session of sessions) {
                    if (session.status.kind === "working") {
                        watch(botId, session.id, signal);
                    }
                }
            },
            statusChanged: (botId, sessionId, status, signal) => {
                if (activeBotId !== botId) {
                    closeWatchers();
                    activeBotId = botId;
                    set({ statuses: new Map() });
                }
                replaceStatus(sessionId, status);
                if (status.kind === "working") {
                    watch(botId, sessionId, signal);
                }
            },
            close: closeWatchers,
        };
    });

    return store;
}
