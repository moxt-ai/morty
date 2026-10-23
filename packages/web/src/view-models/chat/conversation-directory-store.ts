import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "@/services/chat/bot-chat-api";
import { CloudApiError } from "@/services/management/management-api";
import { formatError } from "../format-error.ts";

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "refreshing"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "setup-required" }
    | { readonly kind: "stale"; readonly sessions: readonly ManagedChatSession[]; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

type ArchiveOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "archiving"; readonly sessionId: string }
    | { readonly kind: "failed"; readonly message: string; readonly sessionId: string };

export interface ConversationDirectoryStore {
    readonly state: ConversationDirectoryState;
    readonly archive: ArchiveOperation;
    readonly archiveSession: (sessionId: string, signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
    /**
     * Shows a title this page learned before the directory reports it, such as a rename or an Agent-generated
     * title. A load that was already running keeps it; a load that starts afterwards reports the Runtime's title.
     */
    readonly titleObserved: (sessionId: string, title: string) => void;
    /**
     * Shows a new conversation's first-prompt title. The Runtime's Session listing does not report that title, so it
     * stays until a load reports a different title than the one first listed for the Session, such as a rename made
     * by another client.
     */
    readonly conversationCreated: (sessionId: string, title: string) => void;
}

/** A title this page shows before the directory's Runtime listing does. */
type LocalTitle =
    /** Learned from the Session itself; loads that start after it report the Runtime's title. */
    | { readonly kind: "observed"; readonly title: string; readonly keptByLoad: number }
    /** A new conversation's first-prompt title, kept until the listing reports another title than it first did. */
    | { readonly kind: "created"; readonly title: string; readonly firstListedTitle: string | null };

/** What a finished load leaves of a local title: the same or an updated one, or null when the listing wins. */
function settleLocalTitle(local: LocalTitle, reported: string | undefined, load: number): LocalTitle | null {
    switch (local.kind) {
        case "observed":
            return local.keptByLoad < load ? null : local;
        case "created":
            if (reported === undefined) {
                return local;
            }
            if (local.firstListedTitle === null) {
                return { ...local, firstListedTitle: reported };
            }
            return reported === local.firstListedTitle ? local : null;
        default:
            return local satisfies never;
    }
}

function withTitle(
    sessions: readonly ManagedChatSession[],
    sessionId: string,
    title: string,
): readonly ManagedChatSession[] {
    return sessions.map((session) => (session.id === sessionId ? { ...session, title } : session));
}

export const createConversationDirectoryStore = (
    botId: string,
    requests: Pick<BotChatApi, "archiveManagedSession" | "managedSessions">,
    /** Announced when a load publishes a ready directory, so the owner re-scopes status watching without subscribing. */
    onLoaded: (sessions: readonly ManagedChatSession[]) => void,
) =>
    createStore<ConversationDirectoryStore>()((set, get) => {
        // The Runtime owns Session titles; the directory shows what its last load reported. A title this page learned
        // later is kept only until a load that started after it reports the Runtime's title.
        let loadsStarted = 0;
        const localTitles = new Map<string, LocalTitle>();
        const showTitle = (sessionId: string, local: LocalTitle): void => {
            localTitles.set(sessionId, local);
            const title = local.title;
            set((current) => {
                const state = current.state;
                switch (state.kind) {
                    case "ready":
                    case "refreshing":
                    case "stale":
                        return { state: { ...state, sessions: withTitle(state.sessions, sessionId, title) } };
                    case "loading":
                    case "setup-required":
                    case "failed":
                        return {};
                }
            });
        };
        return {
            state: { kind: "loading" },
            archive: { kind: "idle" },
            archiveSession: async (sessionId, signal) => {
                set({ archive: { kind: "archiving", sessionId } });
                try {
                    await requests.archiveManagedSession(botId, sessionId, signal);
                    signal.throwIfAborted();
                    set((current) => {
                        const state = current.state;
                        switch (state.kind) {
                            case "ready":
                                return {
                                    archive: { kind: "idle" },
                                    state: {
                                        kind: "ready",
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "refreshing":
                                return {
                                    archive: { kind: "idle" },
                                    state: {
                                        kind: "refreshing",
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "stale":
                                return {
                                    archive: { kind: "idle" },
                                    state: {
                                        kind: "stale",
                                        message: state.message,
                                        sessions: state.sessions.filter((session) => session.id !== sessionId),
                                    },
                                };
                            case "loading":
                            case "setup-required":
                            case "failed":
                                return { archive: { kind: "idle" }, state };
                        }
                    });
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
                loadsStarted += 1;
                const load = loadsStarted;
                try {
                    const reported = await requests.managedSessions(botId, signal);
                    signal.throwIfAborted();
                    const reportedTitles = new Map<string, string>(
                        reported.map((session) => [session.id, session.title]),
                    );
                    for (const [sessionId, local] of localTitles) {
                        const next = settleLocalTitle(local, reportedTitles.get(sessionId), load);
                        if (next === null) {
                            localTitles.delete(sessionId);
                        } else {
                            localTitles.set(sessionId, next);
                        }
                    }
                    const sessions = reported.map((session) => {
                        const local = localTitles.get(session.id);
                        return local === undefined ? session : { ...session, title: local.title };
                    });
                    set({ state: { kind: "ready", sessions } });
                    onLoaded(sessions);
                } catch (cause) {
                    if (!signal.aborted) {
                        if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                            set({ state: { kind: "setup-required" } });
                            return;
                        }
                        const message = formatError(cause, "Sessions are unavailable.");
                        set({
                            state:
                                cached === null
                                    ? { kind: "failed", message }
                                    : { kind: "stale", message, sessions: cached },
                        });
                    }
                }
            },
            titleObserved: (sessionId, title) =>
                showTitle(sessionId, { kind: "observed", title, keptByLoad: loadsStarted }),
            conversationCreated: (sessionId, title) =>
                showTitle(sessionId, { kind: "created", title, firstListedTitle: null }),
        };
    });
