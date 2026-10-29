import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "@/services/chat/bot-chat-api";
import { CloudApiError, isRuntimeConnectionFailure } from "@/services/management/management-api";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import { localCalendarDay } from "./conversation-groups.ts";
import { type SessionTitles, type SessionTitlesStore, sessionTitle } from "./session-titles-store.ts";

type DirectorySession = Omit<ManagedChatSession, "title">;

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly DirectorySession[] }
    | { readonly kind: "refreshing"; readonly sessions: readonly DirectorySession[] }
    | { readonly kind: "setup-required" }
    | {
          readonly kind: "stale";
          readonly sessions: readonly DirectorySession[];
          readonly message: string;
          readonly failure: "connection" | "unavailable";
      }
    | { readonly kind: "failed"; readonly message: string; readonly failure: "connection" | "unavailable" };

type ArchiveOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "archiving"; readonly sessionId: string }
    | { readonly kind: "unconfirmed" }
    | { readonly kind: "failed"; readonly message: string; readonly sessionId: string };

export interface ConversationDirectoryStore {
    readonly state: ConversationDirectoryState;
    readonly archive: ArchiveOperation;
    /** The local calendar day observed from the external clock; groups remain derived from it and the sessions. */
    readonly calendarDay: number;
    readonly followCalendar: (signal: AbortSignal) => Promise<void>;
    readonly archiveSession: (sessionId: string, signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

/** Titles are joined at read time, so the list, pane and dialogs share the same Session fact. */
export function conversationDirectorySessions(
    state: ConversationDirectoryState,
    titles: SessionTitles,
): readonly ManagedChatSession[] | null {
    switch (state.kind) {
        case "ready":
        case "refreshing":
        case "stale":
            return state.sessions.map((session) => ({ ...session, title: sessionTitle(titles, session.id) }));
        case "loading":
        case "setup-required":
        case "failed":
            return null;
    }
}

export const createConversationDirectoryStore = (
    botId: string,
    requests: Pick<BotChatApi, "archiveManagedSession" | "managedSessions">,
    /** Announced when a load publishes a ready directory, so the owner re-scopes status watching without subscribing. */
    onLoaded: (sessions: readonly ManagedChatSession[]) => void,
    clock: Clock,
    titles: SessionTitlesStore,
    onArchived: (sessionId: string) => void,
) =>
    createStore<ConversationDirectoryStore>()((set, get) => {
        let calendarOperation: AbortController | null = null;
        return {
            state: { kind: "loading" },
            archive: { kind: "idle" },
            calendarDay: localCalendarDay(new Date(clock.now())),
            followCalendar: async (parent) => {
                calendarOperation?.abort();
                calendarOperation = new AbortController();
                const signal = AbortSignal.any([parent, calendarOperation.signal]);
                while (!signal.aborted) {
                    const now = new Date(clock.now());
                    const calendarDay = localCalendarDay(now);
                    if (calendarDay !== get().calendarDay) {
                        set({ calendarDay });
                    }
                    // Construct the next local midnight so daylight-saving days need not be 24 hours long.
                    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                    const wake = new AbortController();
                    const resumed = () => wake.abort();
                    window.addEventListener("focus", resumed);
                    document.addEventListener("visibilitychange", resumed);
                    try {
                        await clock.sleep(next.getTime() - now.getTime(), AbortSignal.any([signal, wake.signal]));
                    } catch (cause) {
                        if (!signal.aborted && !wake.signal.aborted) {
                            throw cause;
                        }
                    } finally {
                        window.removeEventListener("focus", resumed);
                        document.removeEventListener("visibilitychange", resumed);
                    }
                }
            },
            archiveSession: async (sessionId, signal) => {
                set({ archive: { kind: "archiving", sessionId } });
                try {
                    const result = await requests.archiveManagedSession(botId, sessionId, signal);
                    signal.throwIfAborted();
                    const archive: ArchiveOperation =
                        result.close === "confirmed" ? { kind: "idle" } : { kind: "unconfirmed" };
                    set((current) => {
                        const state = current.state;
                        switch (state.kind) {
                            case "ready":
                                return {
                                    archive,
                                    state: {
                                        kind: "ready",
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "refreshing":
                                return {
                                    archive,
                                    state: {
                                        kind: "refreshing",
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "stale":
                                return {
                                    archive,
                                    state: {
                                        kind: "stale",
                                        failure: state.failure,
                                        message: state.message,
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "loading":
                            case "setup-required":
                            case "failed":
                                return { archive, state };
                        }
                    });
                    onArchived(sessionId);
                } catch (cause) {
                    if (!signal.aborted) {
                        set({
                            archive: {
                                kind: "failed",
                                sessionId,
                                message: formatError(cause, "The session could not be archived."),
                            },
                        });
                    }
                }
            },
            load: async (signal) => {
                const current = get().state;
                const cached =
                    current.kind === "ready" || current.kind === "refreshing" || current.kind === "stale"
                        ? current.sessions
                        : null;
                set({ state: cached === null ? { kind: "loading" } : { kind: "refreshing", sessions: cached } });
                const startedWith = titles.getState().titles;
                try {
                    const reported = await requests.managedSessions(botId, signal);
                    signal.throwIfAborted();
                    titles.getState().directoryLoaded(reported, startedWith);
                    const sessions = reported.map(({ title: _title, ...session }) => session);
                    set({ state: { kind: "ready", sessions } });
                    onLoaded(reported);
                } catch (cause) {
                    if (!signal.aborted) {
                        if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                            set({ state: { kind: "setup-required" } });
                            return;
                        }
                        const message = isRuntimeConnectionFailure(cause)
                            ? "Computer is offline. Sessions will appear when it reconnects."
                            : isChatBridgeError(cause)
                              ? "Connection interrupted. Your sessions will appear when the connection returns."
                              : formatError(cause, "Sessions are unavailable.");
                        const failure =
                            isRuntimeConnectionFailure(cause) || isChatBridgeError(cause)
                                ? ("connection" as const)
                                : ("unavailable" as const);
                        set((current) => {
                            const state = current.state;
                            switch (state.kind) {
                                case "ready":
                                case "refreshing":
                                case "stale":
                                    return { state: { kind: "stale", failure, message, sessions: state.sessions } };
                                case "loading":
                                case "setup-required":
                                case "failed":
                                    return { state: { kind: "failed", failure, message } };
                            }
                        });
                    }
                }
            },
        };
    });
